import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, test } from "vitest";
import { createMailbox } from "../src/mailbox.ts";
import { initGitRepo, tempHome, testCtx } from "./helpers.ts";

function mailboxes() {
  const home = tempHome();
  const repo = join(home, "repo");
  initGitRepo(repo);
  const ctx = testCtx(home, repo, "task");
  return {
    home,
    bot: createMailbox({ ...ctx, caller: "remote" }),
    local: createMailbox({ ...ctx, caller: "claude" }),
    owner: createMailbox(ctx),
  };
}

describe("callers are isolated", () => {
  test("another caller cannot see, read, answer, stop or discard a thread, and gets the same answer as for a missing one", async () => {
    const { bot, local } = mailboxes();
    const sent = await bot.send({ repo: "demo", target: "fake", message: "CoS: take care of xyz" });
    if (!sent.ok) throw new Error(sent.error);
    await expect.poll(() => { const r = bot.inbox(sent.thread_id); return r.ok ? r.status : r.error; }).toBe("succeeded");

    const unknown = { ok: false, error: `unknown thread_id: ${sent.thread_id}` };
    expect(local.inbox(sent.thread_id)).toEqual(unknown);
    expect(local.history(sent.thread_id)).toEqual(unknown);
    expect(local.log({ thread_id: sent.thread_id })).toEqual(unknown);
    expect(local.diff({ thread_id: sent.thread_id })).toEqual(unknown);
    expect(local.stop(sent.thread_id)).toEqual(unknown);
    expect(local.discard(sent.thread_id)).toEqual(unknown);
    expect(await local.send({ thread_id: sent.thread_id, message: "reply to the bot" })).toEqual(unknown);
    expect(local.threads()).toEqual({ threads: [] });

    expect(bot.threads().threads.map((thread) => thread.thread_id)).toEqual([sent.thread_id]);
    expect(bot.inbox(sent.thread_id)).toMatchObject({ ok: true, status: "succeeded" });
  });

  test("a reused request_id from another caller starts its own thread instead of replaying the first caller's", async () => {
    const { bot, local } = mailboxes();
    const first = await bot.send({ repo: "demo", target: "fake", message: "first", request_id: "same-id" });
    const second = await local.send({ repo: "demo", target: "fake", message: "second", request_id: "same-id" });
    if (!first.ok || !second.ok) throw new Error("send failed");
    expect(second.thread_id).not.toBe(first.thread_id);
  });

  test("the owner's CLI still sees every caller's threads", async () => {
    const { bot, local, owner } = mailboxes();
    const a = await bot.send({ repo: "demo", target: "fake", message: "a" });
    const b = await local.send({ repo: "demo", target: "fake", message: "b" });
    if (!a.ok || !b.ok) throw new Error("send failed");
    expect(owner.threads().threads.map((thread) => thread.thread_id).sort()).toEqual([a.thread_id, b.thread_id].sort());
  });
});

describe("the stdio server names its caller", () => {
  const project = fileURLToPath(new URL("..", import.meta.url));
  async function connect(home: string, caller: string, name: string, env: Record<string, string> = {}) {
    const client = new Client({ name, version: "1.0.0" });
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: ["--import", "tsx", "src/server.ts", "--caller", caller], cwd: project, env: { OUTSRC_HOME: home, ...env }, stderr: "pipe",
    }));
    return client;
  }
  const text = (result: unknown) => (result as { content: { text: string }[] }).content.map((part) => part.text).join("");

  test("two registrations do not see each other's threads, and each connection is recorded", async () => {
    const home = tempHome();
    const repo = join(home, "repo");
    initGitRepo(repo);
    const fixture = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url));
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(home, "config.toml"), `[[repos]]\nalias = "demo"\npath = ${JSON.stringify(repo)}\n[targets.fake]\nadapter = "custom"\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([fixture, "task", "--session", "{session_id}"])}\n`);
    const bot = await connect(home, "remote", "grok-bot");
    const local = await connect(home, "claude", "claude-code");
    try {
      const sent = JSON.parse(text(await bot.callTool({ name: "send", arguments: { repo: "demo", target: "fake", message: "CoS: take care of xyz" } })));
      expect(JSON.parse(text(await local.callTool({ name: "threads", arguments: {} })))).toEqual({ threads: [] });
      const peek = await local.callTool({ name: "history", arguments: { thread_id: sent.thread_id } });
      expect(peek).toMatchObject({ isError: true, content: [{ type: "text", text: `unknown thread_id: ${sent.thread_id}` }] });
    } finally {
      await bot.close();
      await local.close();
    }
    const connections = readFileSync(join(home, "clients.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(connections.map((entry) => [entry.caller, entry.client.name]).sort()).toEqual([["claude", "claude-code"], ["remote", "grok-bot"]]);
  });

  test("settings are readable over MCP, and an owner's change applies without a restart", async () => {
    const home = tempHome();
    const repo = join(home, "repo");
    initGitRepo(repo);
    const fixture = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url));
    const { writeFileSync } = await import("node:fs");
    const { spawnSync } = await import("node:child_process");
    writeFileSync(join(home, "config.toml"), `[[repos]]\nalias = "demo"\npath = ${JSON.stringify(repo)}\n[targets.fake]\nadapter = "custom"\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([fixture, "sleep", "--session", "{session_id}"])}\n`);
    const bot = await connect(home, "grok", "outsrc-bot");
    try {
      const before = JSON.parse(text(await bot.callTool({ name: "settings", arguments: {} })));
      expect(before.limits).toEqual({ max_jobs: 4, max_run_minutes: 120 });
      const change = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "config", "set", "limits.max_jobs", "1"], { cwd: project, env: { ...process.env, OUTSRC_HOME: home }, encoding: "utf8" });
      expect(JSON.parse(change.stdout)).toMatchObject({ ok: true, value: 1 });
      expect(JSON.parse(text(await bot.callTool({ name: "settings", arguments: {} }))).limits.max_jobs).toBe(1);
      const first = JSON.parse(text(await bot.callTool({ name: "send", arguments: { repo: "demo", target: "fake", message: "sleep" } })));
      const second = await bot.callTool({ name: "send", arguments: { repo: "demo", target: "fake", message: "sleep again" } });
      expect(second).toMatchObject({ isError: true, content: [{ type: "text", text: "active job limit reached (1); the owner can change it with outsrc config set limits.max_jobs <n>" }] });
      await bot.callTool({ name: "stop", arguments: { thread_id: first.thread_id } });
    } finally {
      await bot.close();
    }
  });

  test("an agent running inside an outsrc job cannot send work onward", async () => {
    const home = tempHome();
    const repo = join(home, "repo");
    initGitRepo(repo);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(home, "config.toml"), `[[repos]]\nalias = "demo"\npath = ${JSON.stringify(repo)}\n[targets.fake]\nadapter = "custom"\ncommand = ${JSON.stringify(process.execPath)}\nargs = []\n`);
    const nested = await connect(home, "claude", "claude-code", { OUTSRC_JOB: "1" });
    try {
      const sent = await nested.callTool({ name: "send", arguments: { repo: "demo", target: "fake", message: "have codex do it" } });
      expect(sent).toMatchObject({ isError: true, content: [{ type: "text", text: "outsrc jobs cannot send new work; only the caller that started the job can" }] });
      expect(JSON.parse(text(await nested.callTool({ name: "threads", arguments: {} })))).toEqual({ threads: [] });
    } finally {
      await nested.close();
    }
  });
});
