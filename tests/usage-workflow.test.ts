import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, test } from "vitest";
import { z } from "zod";
import { createMailbox } from "../src/mailbox.ts";
import { parseAlias, parseTargetName, parseThreadId, type RunSpec, type ThreadRecord } from "../src/types.ts";
import { writeJson } from "../src/state.ts";
import { run } from "../src/wrapper.ts";
import { getBaseCommit } from "../src/workspace.ts";
import { initGitRepo, tempHome } from "./helpers.ts";

const project = fileURLToPath(new URL("..", import.meta.url));
const textResponse = z.object({ content: z.array(z.object({ type: z.literal("text"), text: z.string() })) });
const payload = z.record(z.string(), z.unknown());

test("local CLI and stdio MCP report recorded usage, nulls, history, and caller-scoped totals", async () => {
  const home = tempHome();
  const repo = join(home, "repo");
  initGitRepo(repo);
  const threadId = parseThreadId("0123456789abcdef");
  const directory = join(home, "threads", threadId);
  const runDir = join(directory, "runs", "run-1");
  const script = join(home, "vendor.mjs");
  const envelope = z.object({ result: z.record(z.string(), z.unknown()) }).parse(JSON.parse(
    readFileSync(new URL("./fixtures/plugin-grok-critique.json", import.meta.url), "utf8"))).result;
  writeFileSync(script, `process.stdout.write(JSON.stringify(${JSON.stringify({ ...envelope, structured_output: { kind: "completed", message: "Recorded run", findings: [] } })}));`);
  const thread: ThreadRecord = { version: 2, id: threadId, caller: "bot", repo: parseAlias("demo"), target: parseTargetName("grok"),
    model: "requested-model", effort: "high", taskKind: "task", base: null, worktree: repo, branch: "fixture",
    baseCommit: getBaseCommit(repo), createdAt: new Date().toISOString(), latestRunId: "run-1" };
  mkdirSync(runDir, { recursive: true });
  writeJson(join(directory, "thread.json"), thread);
  writeJson(join(runDir, "run.json"), { id: "run-1", threadId, requestId: null, message: "first", createdAt: thread.createdAt, sessionId: null });
  const spec: RunSpec = { threadId, runId: "run-1", runDir, worktree: repo, baseCommit: thread.baseCommit,
    target: { adapter: "grok", command: process.execPath, args: [script] }, model: thread.model, effort: thread.effort,
    permissions: "ask", sessionId: null, prompt: "fixture", setup: [], autoCommit: false, kind: "task", base: null };
  const before = performance.now();
  await run(spec);
  const elapsed = (performance.now() - before) / 60_000;
  const config = { repos: [{ alias: "demo", path: repo }], targets: {} };
  const box = createMailbox({ home, config, caller: "bot" });
  const inbox = box.inbox(threadId);
  expect(inbox).toMatchObject({ ok: true, status: "succeeded", target: "grok", effort: "high", model: "grok-4.7-build",
    usage: { tokens_in: 30655, tokens_out: 369, estimated_cost_usd: 0.021794 } });
  if (!inbox.ok) throw new Error(inbox.error);
  expect(inbox.usage.wall_minutes).toBeGreaterThan(0);
  expect(inbox.usage.wall_minutes).toBeLessThanOrEqual(elapsed);

  const run2 = join(directory, "runs", "run-2");
  mkdirSync(run2);
  writeJson(join(run2, "run.json"), { id: "run-2", threadId, requestId: null, message: "continue", createdAt: new Date().toISOString(), sessionId: null });
  writeJson(join(run2, "result.json"), { kind: "needs_input", message: "old question", sessionId: "session", findings: [],
    exitCode: 0, finishedAt: new Date().toISOString(), diffstat: "", commit: null });
  writeJson(join(directory, "thread.json"), { ...thread, latestRunId: "run-2" });
  const nullFields = { target: "grok", effort: null, model: null,
    usage: { tokens_in: null, tokens_out: null, estimated_cost_usd: null, wall_minutes: null } };
  expect(box.inbox(threadId)).toMatchObject({ ...nullFields, status: "needs_input" });

  const hiddenId = parseThreadId("fedcba9876543210");
  const hiddenDir = join(home, "threads", hiddenId);
  mkdirSync(join(hiddenDir, "runs", "hidden"), { recursive: true });
  writeJson(join(hiddenDir, "thread.json"), { ...thread, id: hiddenId, caller: "other", target: "private", latestRunId: "hidden" });
  writeJson(join(hiddenDir, "runs", "hidden", "run.json"), { id: "hidden", threadId: hiddenId, requestId: null, message: "hidden", createdAt: thread.createdAt, sessionId: null });
  writeFileSync(join(home, "config.toml"), `[[repos]]\nalias="demo"\npath=${JSON.stringify(repo)}\n`);

  const server = process.env.OUTSRC_TEST_SERVER ?? "src/server.ts";
  const cli = server.endsWith(".ts") ? "src/cli.ts" : "dist/cli.js";
  function command(name: string, args: string[] = []) {
    const child = spawnSync(process.execPath, [...(cli.endsWith(".ts") ? ["--import", "tsx"] : []), cli, name, ...args, "--json"],
      { cwd: project, env: { ...process.env, OUTSRC_HOME: home }, encoding: "utf8" });
    expect(child.status, child.stderr).toBe(0);
    return payload.parse(JSON.parse(child.stdout));
  }
  const client = new Client({ name: "usage-test", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [...(server.endsWith(".ts") ? ["--import", "tsx"] : []), server, "--caller", "bot"],
    cwd: project, env: { OUTSRC_HOME: home }, stderr: "pipe" }));
  async function tool(name: string, args: Record<string, unknown> = {}) {
    const response = textResponse.parse(await client.callTool({ name, arguments: args }));
    return payload.parse(JSON.parse(response.content.map((item) => item.text).join("\n")));
  }
  try {
    writeJson(join(directory, "thread.json"), thread);
    expect(await tool("inbox", { thread_id: threadId })).toEqual(command("inbox", [threadId, "--caller", "bot"]));
    expect(command("inbox", [threadId, "--caller", "bot"])).toMatchObject({ status: "succeeded", model: "grok-4.7-build", effort: "high",
      usage: { tokens_in: 30655, tokens_out: 369, estimated_cost_usd: 0.021794 } });
    writeJson(join(directory, "thread.json"), { ...thread, latestRunId: "run-2" });
    expect(await tool("inbox", { thread_id: threadId })).toEqual(command("inbox", [threadId, "--caller", "bot"]));
    expect(await tool("history", { thread_id: threadId })).toEqual(command("history", [threadId, "--caller", "bot"]));
    expect(await tool("history", { thread_id: threadId })).toMatchObject({ runs: [
      { run_id: "run-1", model: "grok-4.7-build", effort: "high", usage: { tokens_in: 30655, tokens_out: 369, estimated_cost_usd: 0.021794 } },
      { run_id: "run-2", ...nullFields },
    ] });
    const cliUsage = command("usage", ["--caller", "bot"]);
    const mcpUsage = await tool("usage");
    for (const report of [cliUsage, mcpUsage]) {
      expect(report).toMatchObject({ ok: true, today: { runs: 2, tokens_in: { total: null, missing_runs: 1 },
        estimated_cost_usd: { total: null, missing_runs: 1 }, by_target: [{ target: "grok", runs: 2 }] },
      last_7_days: { runs: 2, by_target: [{ target: "grok", runs: 2 }] } });
    }
    const normalize = (report: Record<string, unknown>) => ({ today: report.today, last_7_days: z.object({ by_target: z.unknown(), runs: z.number(),
      tokens_in: z.unknown(), tokens_out: z.unknown(), estimated_cost_usd: z.unknown(), wall_minutes: z.unknown() }).parse(report.last_7_days) });
    expect(normalize(mcpUsage)).toEqual(normalize(cliUsage));
    expect(command("usage")).toMatchObject({ today: { runs: 3, by_target: [{ target: "grok", runs: 2 }, { target: "private", runs: 1 }] } });

    rmSync(join(run2, "result.json"));
    expect(command("inbox", [threadId, "--caller", "bot"])).toMatchObject({ ...nullFields, status: "working" });
    expect(command("usage", ["--caller", "bot"])).toMatchObject({ today: { runs: 2, wall_minutes: { total: null, missing_runs: 1 } } });
    for (const kind of ["cancelled", "failed"]) {
      writeJson(join(run2, "result.json"), { kind, message: kind, sessionId: null, findings: [], exitCode: null,
        finishedAt: new Date().toISOString(), diffstat: "", commit: null });
      expect(command("inbox", [threadId, "--caller", "bot"])).toMatchObject({ ...nullFields, status: kind });
      expect(await tool("inbox", { thread_id: threadId })).toEqual(command("inbox", [threadId, "--caller", "bot"]));
    }
  } finally {
    await client.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
