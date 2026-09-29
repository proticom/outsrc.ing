import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { initGitRepo } from "./helpers.ts";

const project = fileURLToPath(new URL("..", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url));
const payloadSchema = z.record(z.string(), z.unknown());
const textResultSchema = z.object({ content: z.array(z.object({ type: z.literal("text"), text: z.string() })), isError: z.boolean().optional() });
const doneSchema = z.object({ status: z.literal("succeeded"), message: z.string(), worktree: z.string(), session_id: z.string(), findings: z.array(z.unknown()) });

class Harness {
  readonly home = mkdtempSync(join(tmpdir(), "outsrc-workflow-"));
  readonly repo = join(this.home, "source");
  client: Client | null = null;
  readonly threadIds = new Set<string>();

  constructor(options: { setup?: boolean; autoCommit?: boolean } = {}) {
    initGitRepo(this.repo);
    const targets = ["task", "question", "review", "fail", "sleep", "setup", "commit"].map((mode) => `
[targets.${mode}]
adapter = "custom"
command = ${JSON.stringify(process.execPath)}
args = ${JSON.stringify([fixture, mode, "--session", "{session_id}"])}
description = "Fixture ${mode} target"
cost_note = "Fixture uses no model API"
`).join("\n");
    const setupCommand = "const fs=require('node:fs');const count=fs.existsSync('setup-count.txt')?Number(fs.readFileSync('setup-count.txt','utf8')):0;fs.writeFileSync('setup-count.txt',String(count+1));fs.writeFileSync('setup-ready.txt','ready')";
    const setup = options.setup ? `setup = ${JSON.stringify([[process.execPath, "-e", setupCommand]])}\n` : "";
    const autoCommit = options.autoCommit ? "auto_commit = true\n" : "";
    writeFileSync(join(this.home, "config.toml"), `[[repos]]\nalias = "demo"\npath = ${JSON.stringify(this.repo)}\n${setup}${autoCommit}${targets}`);
  }

  async connect(): Promise<void> {
    const server = process.env.OUTSRC_TEST_SERVER ?? "src/server.ts";
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [...(server.endsWith(".ts") ? ["--import", "tsx"] : []), server],
      cwd: project,
      env: { OUTSRC_HOME: this.home },
      stderr: "pipe",
    });
    const client = new Client({ name: "outsrc-workflow-test", version: "1.0.0" });
    await client.connect(transport);
    this.client = client;
  }

  async close(): Promise<void> {
    if (this.client) await this.client.close();
    this.client = null;
  }

  async restart(): Promise<void> {
    await this.close();
    await this.connect();
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (!this.client) throw new Error("MCP client is disconnected");
    const result = textResultSchema.parse(await this.client.callTool({ name, arguments: args }));
    const text = result.content.map((block) => block.text).join("\n");
    if (result.isError) throw new Error(text);
    const payload = payloadSchema.parse(JSON.parse(text));
    if (name === "send") this.threadIds.add(z.string().parse(payload.thread_id));
    return payload;
  }

  async send(target: string, extra: Record<string, unknown> = {}): Promise<{ thread_id: string; run_id: string }> {
    return z.object({ delivered: z.literal(true), thread_id: z.string(), run_id: z.string() }).parse(await this.call("send", { repo: "demo", target, message: "Complete the fixture task", ...extra }));
  }

  async settle(threadId: string): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const result = await this.call("inbox", { thread_id: threadId });
      if (result.status !== "working") return result;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Thread did not settle: ${threadId}`);
  }
}

const harnesses: Harness[] = [];
async function start(options: { setup?: boolean; autoCommit?: boolean } = {}): Promise<Harness> {
  const harness = new Harness(options);
  harnesses.push(harness);
  await harness.connect();
  return harness;
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    if (harness.client) {
      for (const threadId of harness.threadIds) {
        const state = await harness.call("inbox", { thread_id: threadId }).catch(() => null);
        if (state?.status === "working") {
          await harness.call("stop", { thread_id: threadId }).catch(() => null);
          await harness.settle(threadId).catch(() => null);
        }
      }
    }
    await harness.close();
    rmSync(harness.home, { recursive: true, force: true });
  }
});

describe("stdio agent workflow", () => {
  it("lists capabilities and resumes a completed thread without writing SUMMARY.md", async () => {
    const h = await start();
    const targets = z.object({ targets: z.array(payloadSchema) }).parse(await h.call("list_targets"));
    expect(targets.targets.find((target) => target.name === "task")).toMatchObject({
      name: "task", adapter: "custom", available: true, resume: true,
      description: "Fixture task target", cost_note: "Fixture uses no model API",
    });
    const sent = await h.send("task");
    const first = doneSchema.parse(await h.settle(sent.thread_id));
    expect(first.message).toBe("Task completed");
    expect(first.session_id).toBe("fixture-session");
    expect(readFileSync(join(first.worktree, "task.txt"), "utf8")).toBe("task result\n");
    expect(existsSync(join(first.worktree, "SUMMARY.md"))).toBe(false);
    const followup = await h.call("send", { thread_id: sent.thread_id, message: "Continue the task" });
    expect(followup.thread_id).toBe(sent.thread_id);
    expect(followup.run_id).not.toBe(sent.run_id);
    const second = doneSchema.parse(await h.settle(sent.thread_id));
    const history = await h.call("history", { thread_id: sent.thread_id });
    expect(history).toMatchObject({ runs: [
      { run_id: sent.run_id, status: "succeeded", final_message: "Task completed" },
      { run_id: followup.run_id, status: "succeeded", final_message: "Follow-up completed" },
    ] });
    expect(second.message).toBe("Follow-up completed");
    expect(readFileSync(join(second.worktree, "invocations.txt"), "utf8")).toBe("2");
    expect(readFileSync(join(second.worktree, "task.txt"), "utf8")).toBe("follow-up result\n");
    const listed = z.object({ threads: z.array(payloadSchema) }).parse(await h.call("threads"));
    expect(listed.threads).toEqual([expect.objectContaining({
      thread_id: sent.thread_id, repo: "demo", target: "task", kind: "task",
      status: "succeeded", run_id: followup.run_id, run_count: 2, message: "Follow-up completed",
    })]);
  }, 30_000);

  it("continues an active job after the MCP process restarts", async () => {
    const h = await start();
    const sent = await h.send("sleep");
    expect(await h.call("inbox", { thread_id: sent.thread_id })).toMatchObject({ status: "working", run_id: sent.run_id });
    let progress = "";
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !progress.includes("Fixture started")) {
      progress = z.string().parse((await h.call("inbox", { thread_id: sent.thread_id })).progress);
      if (!progress.includes("Fixture started")) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(progress).toBe("Fixture started");
    await h.restart();
    const settled = await h.settle(sent.thread_id);
    expect(settled).toMatchObject({ status: "succeeded", message: "Task completed" });
    const done = doneSchema.parse(settled);
    expect(readFileSync(join(done.worktree, "invocations.txt"), "utf8")).toBe("1");
  }, 30_000);

  it("answers an ended needs-input run after a server restart", async () => {
    const h = await start();
    const sent = await h.send("question");
    expect(await h.settle(sent.thread_id)).toMatchObject({ status: "needs_input", message: "Which color should the result use?", session_id: "fixture-session" });
    await h.restart();
    await h.call("send", { thread_id: sent.thread_id, message: "Use green", request_id: "color-answer" });
    const done = doneSchema.parse(await h.settle(sent.thread_id));
    expect(done.message).toBe("Applied the answer: green");
    expect(readFileSync(join(done.worktree, "answer.txt"), "utf8")).toBe("green\n");
  }, 30_000);

  it("returns the original submission for a repeated request ID across restart", async () => {
    const h = await start();
    const original = await h.send("sleep", { request_id: "same-request" });
    await h.restart();
    const repeated = await h.send("sleep", { request_id: "same-request" });
    expect(repeated).toEqual(original);
    const done = doneSchema.parse(await h.settle(original.thread_id));
    expect(readFileSync(join(done.worktree, "invocations.txt"), "utf8")).toBe("1");
  }, 30_000);

  it("returns structured review findings and reports process failures", async () => {
    const h = await start();
    const review = await h.send("review", { kind: "adversarial_review" });
    const done = doneSchema.parse(await h.settle(review.thread_id));
    expect(done.findings).toEqual([{ priority: "P2", title: "Missing empty-input case", body: "The fixture parser does not handle an empty input.", path: "parser.ts", line: 12 }]);
    const failing = await h.send("fail");
    expect(await h.settle(failing.thread_id)).toMatchObject({ status: "failed", exit_code: 2 });
  }, 30_000);

  it("includes agent commits in final artifacts", async () => {
    const h = await start();
    const sent = await h.send("commit");
    const done = doneSchema.parse(await h.settle(sent.thread_id));
    const diff = await h.call("diff", { thread_id: sent.thread_id });
    expect(diff.patch).toEqual(expect.stringContaining("+task result"));
    expect(execFileSync("git", ["log", "-1", "--format=%s"], { cwd: done.worktree, encoding: "utf8" }).trim()).toBe("Fixture task");
  }, 30_000);

  it("runs configured setup before the agent and can commit its output", async () => {
    const h = await start({ setup: true, autoCommit: true });
    const sent = await h.send("setup");
    const done = doneSchema.parse(await h.settle(sent.thread_id));
    expect(readFileSync(join(done.worktree, "setup-ready.txt"), "utf8")).toBe("ready");
    expect(execFileSync("git", ["show", "HEAD:task.txt"], { cwd: done.worktree, encoding: "utf8" })).toBe("task result\n");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: done.worktree, encoding: "utf8" })).toBe("");
    await h.call("send", { thread_id: sent.thread_id, message: "Continue after setup" });
    const resumed = doneSchema.parse(await h.settle(sent.thread_id));
    expect(resumed.message).toBe("Follow-up completed");
    expect(readFileSync(join(done.worktree, "setup-count.txt"), "utf8")).toBe("1");
    expect(execFileSync("git", ["show", "HEAD:task.txt"], { cwd: done.worktree, encoding: "utf8" })).toBe("follow-up result\n");
  }, 30_000);

  it("preserves completed results when stopped and discards finished worktrees on request", async () => {
    const h = await start();
    const sent = await h.send("task");
    const done = doneSchema.parse(await h.settle(sent.thread_id));
    await h.call("stop", { thread_id: sent.thread_id });
    expect(await h.call("inbox", { thread_id: sent.thread_id })).toMatchObject({ status: "succeeded", message: "Task completed" });
    expect(await h.call("discard", { thread_id: sent.thread_id })).toEqual({ ok: true, discarded: true, thread_id: sent.thread_id });
    expect(await h.call("discard", { thread_id: sent.thread_id })).toEqual({ ok: true, discarded: true, thread_id: sent.thread_id });
    await expect(h.call("send", { thread_id: sent.thread_id, message: "Continue discarded task" })).rejects.toThrow("discarded");
    expect(existsSync(done.worktree)).toBe(false);
    expect(readFileSync(join(h.repo, "README.md"), "utf8")).toBe("fixture\n");
  }, 30_000);
});
