import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

// Live check of the vendor plugin engines through the built MCP server. Uses the installed
// Claude Code plugins and the provider accounts on this machine, so it can incur usage.
const project = fileURLToPath(new URL("..", import.meta.url));
const server = join(project, "dist", "server.js");
if (!existsSync(server)) throw new Error("Run npm run build before the plugin smoke test");
const { installEngine, readLock } = await import(join(project, "dist", "engines.js"));
const lock = readLock();
const names = process.argv.slice(2);
const adapters = z.array(z.enum(["codex-plugin", "grok-plugin"])).parse(names.length ? names : ["codex-plugin", "grok-plugin"]);
const directory = mkdtempSync(join(tmpdir(), "outsrc-plugin-smoke-"));
const responseSchema = z.object({ content: z.array(z.object({ type: z.literal("text"), text: z.string() })), isError: z.boolean().optional() });
const objectSchema = z.record(z.string(), z.unknown());
const sendSchema = z.object({ delivered: z.literal(true), thread_id: z.string(), run_id: z.string() });

function git(repo, ...args) { execFileSync("git", args, { cwd: repo, stdio: "pipe" }); }

async function smoke(adapter) {
  const home = join(directory, adapter);
  const repo = join(home, "source");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "outsrc smoke");
  git(repo, "config", "user.email", "smoke@example.test");
  writeFileSync(join(repo, "README.md"), "Temporary plugin smoke fixture.\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-qm", "fixture");
  git(repo, "checkout", "-qb", "feature");
  writeFileSync(join(repo, "calc.py"), "def ratio(a, b):\n    return a / b\n");
  git(repo, "add", "calc.py");
  git(repo, "commit", "-qm", "add ratio");
  git(repo, "checkout", "-q", "main");
  // Test exactly the pinned engine, downloaded the way outsrc init does, not a Claude Code copy.
  installEngine(home, adapter, lock[adapter]);
  writeFileSync(join(home, "config.toml"), [
    "[[repos]]", 'alias = "demo"', `path = ${JSON.stringify(repo)}`,
    "[targets.engine]", `adapter = ${JSON.stringify(adapter)}`, 'permissions = "auto"',
  ].join("\n"));

  let client = null;
  async function connect() {
    const env = { OUTSRC_HOME: home };
    for (const name of ["PATH", "HOME", "USER", "LANG", "TMPDIR", "TERM", "CLAUDE_CONFIG_DIR"]) {
      if (process.env[name]) env[name] = process.env[name];
    }
    const next = new Client({ name: "outsrc-plugin-smoke", version: "1.0.0" });
    await next.connect(new StdioClientTransport({ command: process.execPath, args: [server], cwd: project, env, stderr: "pipe" }));
    client = next;
  }
  async function call(name, args = {}) {
    const response = responseSchema.parse(await client.callTool({ name, arguments: args }));
    const text = response.content.map((part) => part.text).join("\n");
    if (response.isError) throw new Error(`MCP ${name} failed: ${text}`);
    return objectSchema.parse(JSON.parse(text));
  }
  async function settle(threadId) {
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      const result = await call("inbox", { thread_id: threadId });
      if (result.status !== "working") return result;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error("Plugin run did not finish within 300 seconds");
  }

  const report = { adapter, version: lock[adapter].version, commit: lock[adapter].commit, passed: false, phases: [] };
  try {
    await connect();
    const targets = z.object({ targets: z.array(z.object({ name: z.string(), available: z.boolean() })) }).parse(await call("list_targets"));
    assert.equal(targets.targets[0]?.available, true, "installed plugin engine was not resolved");

    const first = sendSchema.parse(await call("send", {
      repo: "demo", target: "engine", effort: "low",
      message: 'This is a mailbox protocol test. Do not run commands or edit files. Your entire final message must be exactly: NEEDS_INPUT: Which color?',
    }));
    const asked = await settle(first.thread_id);
    report.phases.push({ phase: "question", status: asked.status, message: asked.message ?? null, session_id: asked.session_id ?? null });
    assert.equal(asked.status, "needs_input");
    assert.equal(asked.message, "Which color?");

    await client.close();
    await connect();
    const second = sendSchema.parse(await call("send", {
      thread_id: first.thread_id,
      message: "Use green. Do not run commands or edit files. Your entire final message must be exactly: plugin mailbox passed",
    }));
    const done = await settle(second.thread_id);
    report.phases.push({ phase: "resume", status: done.status, message: done.message ?? null, session_id: done.session_id ?? null });
    assert.equal(done.status, "succeeded");
    assert.equal(done.message, "plugin mailbox passed");
    assert.equal(done.session_id, asked.session_id);

    const review = sendSchema.parse(await call("send", {
      repo: "demo", target: "engine", effort: "low", kind: "adversarial_review", ref: "feature", base: "main",
      message: "Focus on division by zero.",
    }));
    const reviewed = await settle(review.thread_id);
    report.phases.push({ phase: "adversarial_review", status: reviewed.status, message: reviewed.message ?? null, findings: reviewed.findings ?? [] });
    assert.equal(reviewed.status, "succeeded");
    assert.match(String(reviewed.message), /^Verdict: /);

    report.passed = true;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (client) await client.close();
  }
  const leaked = execFileSync("ps", ["-axo", "command"], { encoding: "utf8" }).split("\n").filter((line) => line.includes("app-server-broker") && line.includes(`${basename(directory)}/${adapter}/`));
  report.leaked_brokers = leaked.length;
  if (leaked.length) report.passed = false;
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

const results = await Promise.all(adapters.map(smoke));
writeFileSync(join(directory, "report.json"), `${JSON.stringify({ built_server: server, results }, null, 2)}\n`);
process.stdout.write(`Plugin smoke report: ${join(directory, "report.json")}\n`);
if (results.some((result) => !result.passed)) process.exitCode = 1;
