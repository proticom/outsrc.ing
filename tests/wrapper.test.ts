import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import { MAX_LOG_BYTES } from "../src/limits.ts";
import { parseThreadId, type RunSpec } from "../src/types.ts";
import { getBaseCommit } from "../src/workspace.ts";
import { run } from "../src/wrapper.ts";
import { initGitRepo, tempHome } from "./helpers.ts";

function fixture(code: string): RunSpec {
  const home = tempHome();
  const worktree = join(home, "repo");
  initGitRepo(worktree);
  const script = join(home, "agent.mjs");
  writeFileSync(script, code);
  return {
    threadId: parseThreadId("0123456789abcdef"),
    runId: "run-1",
    runDir: join(home, "run-1"),
    worktree,
    baseCommit: getBaseCommit(worktree),
    target: { adapter: "custom", command: process.execPath, args: [script] },
    model: null,
    effort: null,
    permissions: "ask",
    sessionId: null,
    prompt: "Complete the fixture",
    setup: [],
    autoCommit: false,
    kind: "task",
    base: null,
  };
}

const completed = `process.stdout.write(JSON.stringify({kind:"completed",message:"Fixture complete",sessionId:"fixture-session",findings:[]}));`;

describe("standalone wrapper", () => {
  test("keeps reported native tokens when the agent exceeds its deadline", async () => {
    const spec = fixture(`process.stdout.write(JSON.stringify({usage:{input_tokens:17,output_tokens:4}}));setInterval(()=>{},1000);`);
    spec.target.adapter = "claude";
    spec.model = "requested-model";
    spec.effort = "low";
    spec.deadlineMs = 300;
    const result = await run(spec);
    expect(result).toMatchObject({ kind: "failed", message: expect.stringMatching(/^Agent execution failed: Error: Run exceeded the \d+ms deadline$/),
      usage: { tokens_in: 17, tokens_out: 4, model: "requested-model", effort: "low" } });
    expect(JSON.parse(readFileSync(join(spec.runDir, "result.json"), "utf8"))).toMatchObject({
      kind: "failed", usage: { tokens_in: 17, tokens_out: 4 } });
  });

  test("persists completed Codex turn usage before cancellation or a malformed final answer", async () => {
    const spec = fixture(`process.stdout.write('{"type":"turn.completed","usage":{"input_tokens":25,"output_tokens":6}}\\n');process.stdout.write('{"type":"turn.failed"');`);
    spec.target.adapter = "codex";
    const script = spec.target.args[0];
    if (!script) throw new Error("Missing fixture executable");
    writeFileSync(script, `#!${process.execPath}\n${readFileSync(script, "utf8")}`);
    chmodSync(script, 0o700);
    spec.target.command = script;
    spec.target.args = [];
    spec.model = "codex-model";
    expect(await run(spec)).toMatchObject({ kind: "failed", usage: { tokens_in: 25, tokens_out: 6, model: "codex-model" } });
    expect(JSON.parse(readFileSync(join(spec.runDir, "usage.json"), "utf8"))).toMatchObject({
      tokens_in: 25, tokens_out: 6, model: "codex-model" });
  });

  test("reports native tokens on a cancelled finished run", async () => {
    const spec = fixture(`import {writeFileSync} from 'node:fs';process.stdout.write(JSON.stringify({usage:{input_tokens:17,output_tokens:4},structured_output:{kind:"completed",message:"Done",findings:[]}}));writeFileSync(process.argv.at(-1),'1');`);
    spec.target.adapter = "claude";
    spec.prompt = join(spec.runDir, "cancelled");
    expect(await run(spec)).toMatchObject({ kind: "cancelled", message: "Task cancelled", usage: { tokens_in: 17, tokens_out: 4 } });
  });

  test("retains metadata if output ends with malformed trailing bytes", async () => {
    const spec = fixture(`process.stdout.write(JSON.stringify({usage:{input_tokens:17,output_tokens:4}}));setTimeout(()=>process.stdout.write('broken tail'),50);`);
    spec.target.adapter = "grok";
    expect(await run(spec)).toMatchObject({ kind: "failed", usage: { tokens_in: 17, tokens_out: 4 } });
  });

  test("persists measured usage even when result collection fails", async () => {
    const spec = fixture(`process.stdout.write(JSON.stringify({session_id:"native-session",usage:{input_tokens:120,output_tokens:8},total_cost_usd:0.04,modelUsage:{"observed-model":{}},structured_output:{kind:"completed",message:"Native result",findings:[]}}));`);
    spec.target.adapter = "claude";
    spec.effort = "high";
    spec.baseCommit = "missing-base-commit";
    const clock = vi.spyOn(performance, "now").mockReturnValueOnce(1000).mockReturnValueOnce(121000);
    try {
      const result = await run(spec);
      expect(result.kind).toBe("failed");
      expect(JSON.parse(readFileSync(join(spec.runDir, "result.json"), "utf8")).usage).toEqual({
        tokens_in: 120, tokens_out: 8, estimated_cost_usd: 0.04, wall_minutes: 2, model: "observed-model", effort: "high",
      });
    } finally { clock.mockRestore(); }
  });

  test("does not claim an effort that a custom invocation never passes", async () => {
    const spec = fixture(completed);
    spec.effort = "high";
    expect((await run(spec)).usage).toMatchObject({ tokens_in: null, tokens_out: null, estimated_cost_usd: null, model: null, effort: null });
  });
  test("does not claim effort for a Codex plugin branch review", async () => {
    const spec = fixture(`process.stdout.write(JSON.stringify({review:"Review",codex:{status:0},result:{verdict:"ok",summary:"Review complete",findings:[]}}));`);
    const script = spec.target.args[0];
    if (!script) throw new Error("missing fixture script");
    spec.target = { adapter: "codex-plugin", command: script, args: [] };
    spec.kind = "review";
    spec.base = "HEAD";
    spec.effort = "high";
    expect(await run(spec)).toMatchObject({ kind: "completed", message: "Verdict: ok\n\nReview complete",
      usage: { tokens_in: null, tokens_out: null, estimated_cost_usd: null, model: null, effort: null } });
  });
  test("persists a native structured result without requiring SUMMARY.md", async () => {
    const spec = fixture(`process.stderr.write("agent diagnostic\\n");process.stdout.write(JSON.stringify({session_id:"native-session",structured_output:{kind:"completed",message:"Native result",findings:[{priority:"P2",title:"Missing retry",body:"Retry this operation",path:"src/client.ts",line:12}]}}));`);
    spec.target.adapter = "claude";
    const result = await run(spec);
    expect(result).toMatchObject({
      kind: "completed",
      message: "Native result",
      sessionId: "native-session",
      exitCode: 0,
      commit: null,
      diffstat: "",
      findings: [{ priority: "P2", title: "Missing retry", body: "Retry this operation", path: "src/client.ts", line: 12 }],
    });
    expect(JSON.parse(readFileSync(join(spec.runDir, "result.json"), "utf8"))).toMatchObject({
      kind: "completed", message: "Native result", sessionId: "native-session", exitCode: 0,
    });
    expect(JSON.parse(readFileSync(join(spec.runDir, "output-schema.json"), "utf8")).required).toEqual(["kind", "message", "findings"]);
    expect(readFileSync(join(spec.runDir, "run.log"), "utf8")).toContain("agent diagnostic\n");
    expect(existsSync(join(spec.worktree, "SUMMARY.md"))).toBe(false);
    expect(existsSync(join(spec.runDir, "result.json.tmp"))).toBe(false);
  });

  test("runs setup commands sequentially in the workspace before execution", async () => {
    const spec = fixture(`import {readFileSync} from 'node:fs';process.stdout.write(JSON.stringify({kind:"completed",message:readFileSync('ready.txt','utf8'),sessionId:null,findings:[]}));`);
    spec.setup = [
      [process.execPath, "-e", "require('node:fs').writeFileSync('ready.txt','first');process.stdout.write('setup first\\n')"],
      [process.execPath, "-e", "const fs=require('node:fs');fs.writeFileSync('ready.txt',fs.readFileSync('ready.txt','utf8')+' then second')"],
    ];
    const result = await run(spec);
    expect(result).toMatchObject({ kind: "completed", message: "first then second", exitCode: 0 });
    expect(result.diffstat).toContain("ready.txt");
    expect(readFileSync(join(spec.runDir, "run.log"), "utf8")).toContain("setup first\n");
  });

  test("records a setup failure without launching the agent", async () => {
    const spec = fixture(`import {writeFileSync} from 'node:fs';writeFileSync('agent-started','yes');${completed}`);
    spec.setup = [[process.execPath, "-e", "process.stderr.write('setup failed\\n');process.exit(7)"]];
    const result = await run(spec);
    expect(result).toMatchObject({ kind: "failed", message: "Setup command 1 failed: Error: exited with 7", exitCode: 7 });
    expect(readFileSync(join(spec.runDir, "run.log"), "utf8")).toBe("setup failed\n");
    expect(existsSync(join(spec.worktree, "agent-started"))).toBe(false);
  });

  test("records asynchronous agent spawn failures", async () => {
    const spec = fixture(completed);
    spec.target.command = join(spec.runDir, "missing-command");
    const result = await run(spec);
    expect(result.kind).toBe("failed");
    expect(result.message).toContain("Agent execution failed: Error: spawn");
    expect(result.message).toContain("ENOENT");
    expect(result.exitCode).toBe(null);
    expect(JSON.parse(readFileSync(join(spec.runDir, "result.json"), "utf8")).kind).toBe("failed");
  });

  test("rejects a successful-looking response from an unsuccessful process", async () => {
    const spec = fixture(`${completed}process.exitCode=4;`);
    expect(await run(spec)).toMatchObject({
      kind: "failed", message: "Agent process exited with 4", sessionId: "fixture-session", exitCode: 4,
    });
  });

  test("fails malformed output even when a legacy summary exists", async () => {
    const spec = fixture(`import {writeFileSync} from 'node:fs';writeFileSync('SUMMARY.md','An obsolete success summary');process.stdout.write('not structured output');`);
    expect(await run(spec)).toMatchObject({ kind: "failed", message: "Invalid custom agent output", exitCode: 0 });
  });

  test("preserves a session for a subsequent invocation", async () => {
    const spec = fixture(`const resumed=process.argv[3]==='session-1';process.stdout.write(JSON.stringify({kind:resumed?'completed':'needs_input',message:resumed?process.argv.at(-1):'Which color?',sessionId:'session-1',findings:[]}));`);
    spec.target.args.push("--session", "{session_id}");
    const first = await run(spec);
    expect(first).toMatchObject({ kind: "needs_input", message: "Which color?", sessionId: "session-1", exitCode: 0 });
    const second = await run({ ...spec, runId: "run-2", runDir: join(spec.runDir, "..", "run-2"), sessionId: first.sessionId, prompt: "Use blue", setup: [] });
    expect(second).toMatchObject({ kind: "completed", message: "Use blue", sessionId: "session-1", exitCode: 0 });
  });

  test("rejects a question when the custom adapter cannot resume", async () => {
    const spec = fixture(`process.stdout.write(JSON.stringify({kind:'needs_input',message:'Which color?',sessionId:'session-1',findings:[]}));`);
    expect(await run(spec)).toMatchObject({
      kind: "failed", message: "Custom adapter requested input but has no {session_id} argument for resuming", sessionId: "session-1",
    });
  });

  test("commits completed work and reports its difference from the starting commit", async () => {
    const spec = fixture(`import {writeFileSync} from 'node:fs';writeFileSync('result.txt','completed work\\n');${completed}`);
    spec.autoCommit = true;
    const result = await run(spec);
    expect(result.kind).toBe("completed");
    expect(result.diffstat).toContain("result.txt");
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(execFileSync("git", ["show", "HEAD:result.txt"], { cwd: spec.worktree, encoding: "utf8" })).toBe("completed work\n");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: spec.worktree, encoding: "utf8" })).toBe("");
  });

  test("keeps failed work uncommitted when automatic commits are enabled", async () => {
    const spec = fixture(`import {writeFileSync} from 'node:fs';writeFileSync('partial.txt','partial work');${completed}process.exitCode=5;`);
    spec.autoCommit = true;
    const result = await run(spec);
    expect(result).toMatchObject({ kind: "failed", exitCode: 5, commit: null });
    expect(result.diffstat).toContain("partial.txt");
    expect(getBaseCommit(spec.worktree)).toBe(spec.baseCommit);
    expect(readFileSync(join(spec.worktree, "partial.txt"), "utf8")).toBe("partial work");
  });

  test("reports result collection failures", async () => {
    const spec = fixture(completed);
    spec.baseCommit = "missing-base-commit";
    const result = await run(spec);
    expect(result).toMatchObject({ kind: "failed", exitCode: 0, sessionId: "fixture-session" });
    expect(result.message).toContain("Result collection failed:");
  });

  test("runs through the --spec CLI entrypoint", () => {
    const spec = fixture(completed);
    const specPath = join(spec.worktree, "..", "spec.json");
    writeFileSync(specPath, JSON.stringify(spec));
    const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/wrapper.ts", import.meta.url)), "--spec", specPath], { encoding: "utf8" });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(spec.runDir, "process.json"), "utf8"))).toMatchObject({ pid: child.pid, pgid: child.pid, startedAt: expect.stringMatching(/\d{4}/) });
    expect(JSON.parse(readFileSync(join(spec.runDir, "result.json"), "utf8"))).toMatchObject({ kind: "completed", message: "Fixture complete", exitCode: 0 });
  });

  test("stops appending once the log reaches 1 MiB", async () => {
    const spec = fixture(`process.stderr.write("x".repeat(1200000));${completed}`);
    const result = await run(spec);
    expect(result.kind).toBe("completed");
    const log = readFileSync(join(spec.runDir, "run.log"));
    expect(log.includes("[outsrc log truncated]")).toBe(true);
    expect(log.length).toBeLessThanOrEqual(MAX_LOG_BYTES + Buffer.byteLength("\n[outsrc log truncated]\n"));
  });

  test("kills a run that exceeds its deadline", async () => {
    const spec = fixture(`import {writeFileSync} from "node:fs"; setTimeout(() => writeFileSync("too-late","yes"), 5000); setInterval(() => {}, 1000);`);
    spec.deadlineMs = 200;
    const started = Date.now();
    const result = await run(spec);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result.message).toContain("deadline");
    expect(existsSync(join(spec.worktree, "too-late"))).toBe(false);
  });

  test("a run without a deadline is not stopped for taking time", async () => {
    const spec = fixture(`setTimeout(() => {${completed}}, 400);`);
    spec.deadlineMs = null;
    const result = await run(spec);
    expect(result.kind).toBe("completed");
  });

  test("does not launch an agent after cancellation", async () => {
    const spec = fixture(`import {writeFileSync} from "node:fs"; writeFileSync("agent-started","yes");${completed}`);
    mkdirSync(spec.runDir, { recursive: true });
    writeFileSync(join(spec.runDir, "cancelled"), "1");
    expect(await run(spec)).toMatchObject({ kind: "cancelled", message: "Task cancelled", exitCode: null });
    expect(existsSync(join(spec.worktree, "agent-started"))).toBe(false);
  });
});
