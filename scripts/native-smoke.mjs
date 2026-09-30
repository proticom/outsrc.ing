import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

const project = fileURLToPath(new URL("..", import.meta.url));
const server = join(project, "dist", "server.js");
if (!existsSync(server)) throw new Error("Run npm run build before the native smoke test");
const names = process.argv.slice(2);
const adapters = z.array(z.enum(["claude", "codex", "grok"]))
  .parse(names.length ? names : ["claude", "codex", "grok"]);
const directory = mkdtempSync(join(tmpdir(), "outsrc-native-mailbox-"));
const reportFile = join(directory, "report.json");
const responseSchema = z.object({
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
  isError: z.boolean().optional(),
});
const objectSchema = z.record(z.string(), z.unknown());
const sendSchema = z.object({ delivered: z.literal(true), thread_id: z.string(), run_id: z.string() });
const waitingSchema = z.object({
  status: z.literal("needs_input"), message: z.literal("Which color?"),
  session_id: z.string().min(1), run_id: z.string(), question_id: z.string(),
});
const completeSchema = z.object({
  status: z.literal("succeeded"), message: z.literal("native mailbox passed"),
  session_id: z.string().min(1), run_id: z.string(), exit_code: z.literal(0),
  findings: z.array(z.unknown()).length(0),
  usage: z.object({ tokens_in: z.number().int().nonnegative(), tokens_out: z.number().int().nonnegative() }),
});

async function smoke(adapter) {
  const home = join(directory, adapter);
  const repo = join(home, "source");
  mkdirSync(repo, { recursive: true });
  for (const args of [["init", "-q"], ["config", "user.name", "outsrc smoke"], ["config", "user.email", "smoke@example.test"]]) {
    execFileSync("git", args, { cwd: repo });
  }
  writeFileSync(join(repo, "README.md"), "Temporary native mailbox smoke fixture.\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repo });
  writeFileSync(join(home, "config.toml"), [
    "[[repos]]", 'alias = "demo"', `path = ${JSON.stringify(repo)}`,
    `[targets.${adapter}]`, `adapter = ${JSON.stringify(adapter)}`, `command = ${JSON.stringify(adapter)}`,
    "args = []", 'permissions = "auto"',
  ].join("\n"));

  let client = null;
  let threadId = null;
  async function connect() {
    const env = { OUTSRC_HOME: home };
    for (const name of ["PATH", "HOME", "USER", "LANG", "TMPDIR", "TERM"]) {
      if (process.env[name]) env[name] = process.env[name];
    }
    const transport = new StdioClientTransport({
      command: process.execPath, args: [server], cwd: project, env, stderr: "pipe",
    });
    const next = new Client({ name: "outsrc-native-smoke", version: "1.0.0" });
    await next.connect(transport);
    client = next;
  }
  async function call(name, args = {}) {
    if (!client) throw new Error("MCP client is disconnected");
    const response = responseSchema.parse(await client.callTool({ name, arguments: args }));
    if (response.isError) throw new Error(`MCP ${name} failed`);
    return objectSchema.parse(JSON.parse(response.content.map((part) => part.text).join("\n")));
  }
  async function settle() {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const result = await call("inbox", { thread_id: threadId });
      if (result.status !== "working") return result;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error("Native run did not finish within 120 seconds");
  }

  const report = { adapter, passed: false, phases: [] };
  try {
    await connect();
    const first = sendSchema.parse(await call("send", {
      repo: "demo", target: adapter, effort: "low",
      message: 'This is a mailbox protocol test. Do not use tools or edit files. You need my color decision before completing. Return kind="needs_input", message exactly "Which color?", and findings=[] now, then end this run.',
    }));
    threadId = first.thread_id;
    const initialResult = await settle();
    report.phases.push({ phase: "question", status: initialResult.status, session_id: initialResult.session_id ?? null });
    const waiting = waitingSchema.parse(initialResult);
    assert.equal(waiting.run_id, first.run_id);
    assert.equal(waiting.question_id, first.run_id);
    report.phases[0].message = waiting.message;
    await client.close();
    client = null;
    await connect();
    const second = sendSchema.parse(await call("send", {
      thread_id: threadId,
      message: 'Use green. Do not use tools or edit files. Complete with kind="completed", message exactly "native mailbox passed", and findings=[].',
    }));
    assert.equal(second.thread_id, first.thread_id);
    assert.notEqual(second.run_id, first.run_id);
    const finalResult = await settle();
    report.phases.push({ phase: "resume", status: finalResult.status, session_id: finalResult.session_id ?? null, exit_code: finalResult.exit_code ?? null });
    const done = completeSchema.parse(finalResult);
    assert.equal(done.session_id, waiting.session_id);
    assert.equal(done.run_id, second.run_id);
    report.phases[1].message = done.message;
    report.phases[1].usage = done.usage;
    const history = z.object({ threads: z.array(z.object({ thread_id: z.string(), run_count: z.number() })) })
      .parse(await call("threads"));
    assert.equal(history.threads.find((thread) => thread.thread_id === threadId)?.run_count, 2);
    report.run_count = 2;
    report.passed = true;
  } catch (error) {
    report.error = error instanceof z.ZodError ? "Native result did not match the expected protocol" :
      error instanceof assert.AssertionError ? "Native continuation assertion failed" : String(error);
  } finally {
    if (client) {
      if (threadId) {
        const status = await call("inbox", { thread_id: threadId }).catch(() => null);
        if (status?.status === "working") await call("stop", { thread_id: threadId }).catch(() => null);
      }
      await client.close();
    }
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return report;
}

process.stdout.write(`Native mailbox smoke report: ${reportFile}\n`);
const results = await Promise.all(adapters.map(smoke));
writeFileSync(reportFile, `${JSON.stringify({ built_server: server, results }, null, 2)}\n`);
if (results.some((result) => !result.passed)) process.exitCode = 1;
