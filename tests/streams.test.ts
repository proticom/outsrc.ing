import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { createScanner, readLogFrom, startStreamServer, type StreamServer } from "../src/streams.ts";
import type { ThreadId } from "../src/types.ts";
import { tempHome } from "./helpers.ts";

type Fixture = { id: string; run?: string; target?: string; log?: string; state: "working" | "stopped" | { finishedAgoMs: number } };

// Writes the same files a real send and wrapper leave on disk, without starting any agent.
function writeThread(home: string, fixture: Fixture): string {
  const run = fixture.run ?? `run${fixture.id.slice(0, 4)}`;
  const dir = join(home, "threads", fixture.id);
  const runDir = join(dir, "runs", run);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ id: run, threadId: fixture.id, requestId: null, message: "m", createdAt: new Date(Date.now() - 90_000).toISOString(), sessionId: null }));
  writeFileSync(join(runDir, "run.log"), fixture.log ?? "");
  if (fixture.state === "working") writeFileSync(join(runDir, "process.json"), JSON.stringify({ pid: process.pid, pgid: process.pid, startedAt: "x" }));
  else if (fixture.state === "stopped") writeFileSync(join(runDir, "process.json"), JSON.stringify({ pid: 2 ** 22 + 7, pgid: 2 ** 22 + 7, startedAt: "x" }));
  else writeFileSync(join(runDir, "result.json"), JSON.stringify({ kind: "completed", message: "done", sessionId: null, findings: [], exitCode: 0, finishedAt: new Date(Date.now() - fixture.state.finishedAgoMs).toISOString(), diffstat: "", commit: null }));
  writeFileSync(join(dir, "thread.json"), JSON.stringify({
    version: 2, id: fixture.id, caller: "grok", repo: "demo", target: fixture.target ?? "claude", model: null, effort: null,
    taskKind: "task", base: null, worktree: `/tmp/wt/${fixture.id}`, branch: `agent/outsrc-${fixture.id}`, baseCommit: "abc",
    createdAt: new Date().toISOString(), latestRunId: run,
  }));
  return join(runDir, "run.log");
}

function finish(logFile: string): void {
  writeFileSync(join(logFile, "..", "result.json"), JSON.stringify({ kind: "failed", message: "x", sessionId: null, findings: [], exitCode: 1, finishedAt: new Date().toISOString(), diffstat: "", commit: null }));
}

type Event = { event: string; data: any };
async function subscribe(url: string) {
  const controller = new AbortController();
  const response = await fetch(url.replace("/?", "/events?"), { signal: controller.signal });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: Event[] = [];
  let buffer = "";
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let split: number;
        while ((split = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (event && data) events.push({ event, data: JSON.parse(data) });
        }
      }
    } catch { /* aborted */ }
  })();
  async function waitFor(predicate: (event: Event) => boolean, timeoutMs = 4000): Promise<Event> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = events.find(predicate);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`no matching event; saw ${JSON.stringify(events.map((e) => e.event))}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  const logText = (id: string) => events.filter((e) => e.event === "log" && e.data.thread_id === id).map((e) => e.data.text).join("");
  return { events, waitFor, logText, close: async () => { controller.abort(); await pump; } };
}

function snapshot(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).sort().map((name) => `${name}:${statSync(join(dir, name)).mtimeMs}`);
}

const A = "aaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbb";
const C = "cccccccccccccccc";
const OLD = "dddddddddddddddd";
const RECENT = "eeeeeeeeeeeeeeee";
const STOPPED = "ffffffffffffffff";

let server: StreamServer | null = null;
afterEach(async () => { await server?.close(); server = null; });

test("scanner lists working, stopped and recently finished threads and hides old finished ones", () => {
  const home = tempHome();
  writeThread(home, { id: A, state: "working", target: "claude" });
  writeThread(home, { id: B, state: "working", target: "codex" });
  writeThread(home, { id: STOPPED, state: "stopped" });
  writeThread(home, { id: RECENT, state: { finishedAgoMs: 60_000 } });
  writeThread(home, { id: OLD, state: { finishedAgoMs: 3 * 3600_000 } });
  mkdirSync(join(home, "threads", "not-a-thread"));
  const panes = createScanner({ home, recentMs: 15 * 60_000 })();
  expect(panes.slice(0, 2).every((pane) => pane.live)).toBe(true);
  expect(panes.map((pane) => [pane.thread_id, pane.target, pane.status, pane.live]).sort()).toEqual([
    [A, "claude", "working", true],
    [B, "codex", "working", true],
    [RECENT, "claude", "succeeded", false],
    [STOPPED, "claude", "stopped", false],
  ]);
  expect(panes.find((pane) => pane.thread_id === A)?.branch).toBe(`agent/outsrc-${A}`);
});

test("scanner with a pinned thread shows only that thread, even when it finished long ago, and nothing before it exists", () => {
  const home = tempHome();
  const scan = createScanner({ home, thread: OLD as ThreadId, recentMs: 60_000 });
  expect(scan()).toEqual([]);
  writeThread(home, { id: A, state: "working" });
  writeThread(home, { id: OLD, state: { finishedAgoMs: 3 * 3600_000 } });
  expect(scan().map((pane) => [pane.thread_id, pane.status])).toEqual([[OLD, "succeeded"]]);
});

test("readLogFrom returns the tail first, then only appended bytes, and holds back a split UTF-8 character", () => {
  const home = tempHome();
  const log = writeThread(home, { id: A, state: "working", log: "x".repeat(70 * 1024) + "END\n" });
  const pane = { thread_id: A as ThreadId, run_id: `run${A.slice(0, 4)}` };
  const first = readLogFrom(home, pane, null);
  expect(first.reset).toBe(true);
  expect(first.text.length).toBe(64 * 1024);
  expect(first.text.endsWith("END\n")).toBe(true);
  appendFileSync(log, Buffer.from([0x68, 0x69, 0xe2, 0x82]));
  const partial = readLogFrom(home, pane, first.next);
  expect(partial).toEqual({ text: "hi", next: first.next + 2, reset: false });
  appendFileSync(log, Buffer.from([0xac, 0x0a]));
  expect(readLogFrom(home, pane, partial.next)).toEqual({ text: "€\n", next: partial.next + 4, reset: false });
  writeFileSync(log, "rotated\n");
  expect(readLogFrom(home, pane, partial.next + 4)).toEqual({ text: "rotated\n", next: 8, reset: true });
});

test("two working jobs stream as two panes that follow log growth, a new thread appears live, and a finished one goes muted", async () => {
  const home = tempHome();
  const logA = writeThread(home, { id: A, state: "working", target: "claude", log: "a: starting\n" });
  const logB = writeThread(home, { id: B, state: "working", target: "codex", log: "b: starting\n" });
  server = await startStreamServer({ home, pollMs: 50 });
  const stream = await subscribe(server.url);
  try {
    const first = await stream.waitFor((e) => e.event === "threads");
    expect(first.data.threads.map((t: any) => [t.thread_id, t.target, t.status, t.live]).sort()).toEqual([[A, "claude", "working", true], [B, "codex", "working", true]]);
    await stream.waitFor((e) => e.event === "log" && e.data.thread_id === B);
    expect(stream.logText(A)).toBe("a: starting\n");
    expect(stream.logText(B)).toBe("b: starting\n");

    appendFileSync(logA, "a: step 1\n");
    appendFileSync(logB, "b: step 1\n");
    appendFileSync(logA, "a: step 2\n");
    await stream.waitFor(() => stream.logText(A).endsWith("a: step 2\n") && stream.logText(B).endsWith("b: step 1\n"));
    expect(stream.logText(A)).toBe("a: starting\na: step 1\na: step 2\n");
    expect(stream.logText(B)).toBe("b: starting\nb: step 1\n");

    writeThread(home, { id: C, state: "working", target: "grok", log: "c: hello\n" });
    const withC = await stream.waitFor((e) => e.event === "threads" && e.data.threads.some((t: any) => t.thread_id === C));
    expect(withC.data.threads.find((t: any) => t.thread_id === C)).toMatchObject({ target: "grok", status: "working", live: true });
    await stream.waitFor(() => stream.logText(C) === "c: hello\n");

    finish(logB);
    const done = await stream.waitFor((e) => e.event === "threads" && e.data.threads.some((t: any) => t.thread_id === B && !t.live));
    expect(done.data.threads.find((t: any) => t.thread_id === B)).toMatchObject({ status: "failed", live: false });
    const logEvents = stream.events.filter((e) => e.event === "log").length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(stream.events.filter((e) => e.event === "log").length).toBe(logEvents);
  } finally {
    await stream.close();
  }
});

test("watching writes nothing, not even the failed result inbox would record for a stopped wrapper", async () => {
  const home = tempHome();
  writeThread(home, { id: A, state: "working", log: "a\n" });
  writeThread(home, { id: STOPPED, state: "stopped", log: "s\n" });
  writeThread(home, { id: RECENT, state: { finishedAgoMs: 1000 }, log: "r\n" });
  const before = snapshot(home);
  server = await startStreamServer({ home, pollMs: 20 });
  const stream = await subscribe(server.url);
  try {
    await stream.waitFor(() => stream.logText(A) === "a\n" && stream.logText(STOPPED) === "s\n" && stream.logText(RECENT) === "r\n");
    await new Promise((resolve) => setTimeout(resolve, 200));
  } finally {
    await stream.close();
  }
  expect(snapshot(home)).toEqual(before);
});

test("a follow-up run replaces the pane's log instead of appending to it", async () => {
  const home = tempHome();
  writeThread(home, { id: A, state: { finishedAgoMs: 1000 }, log: "first run\n" });
  server = await startStreamServer({ home, pollMs: 50 });
  const stream = await subscribe(server.url);
  try {
    await stream.waitFor((e) => e.event === "log" && e.data.text === "first run\n");
    writeThread(home, { id: A, run: "second", state: "working", log: "second run\n" });
    const next = await stream.waitFor((e) => e.event === "log" && e.data.run_id === "second");
    expect(next.data).toEqual({ thread_id: A, run_id: "second", text: "second run\n", reset: true });
  } finally {
    await stream.close();
  }
});

test("an empty home streams an empty list and stops polling once the page disconnects", async () => {
  const home = tempHome();
  server = await startStreamServer({ home, pollMs: 50 });
  const stream = await subscribe(server.url);
  const first = await stream.waitFor((e) => e.event === "threads");
  expect(first.data.threads).toEqual([]);
  expect(server.clients()).toBe(1);
  await stream.close();
  const deadline = Date.now() + 2000;
  while (server.clients() !== 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  expect(server.clients()).toBe(0);
});

test("the server refuses requests without the token or from another Host, and serves the page with it", async () => {
  const home = tempHome();
  server = await startStreamServer({ home, token: "secret" });
  const base = `http://127.0.0.1:${server.port}`;
  expect((await fetch(`${base}/`)).status).toBe(403);
  expect((await fetch(`${base}/events?token=wrong`)).status).toBe(403);
  const rebound = await new Promise<number>((resolve, reject) => {
    request({ host: "127.0.0.1", port: server!.port, path: "/?token=secret", headers: { host: "evil.example" } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); })
      .on("error", reject).end();
  });
  expect(rebound).toBe(403);
  const page = await fetch(`${base}/?token=secret`);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("<title>outsrc streams</title>");
});

test("outsrc streams --help and outsrc watch --help describe the viewer", () => {
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  for (const name of ["streams", "watch"]) {
    const text = execFileSync(process.execPath, ["--import", "tsx", cli, name, "--help"], { cwd, encoding: "utf8", env: { ...process.env, OUTSRC_HOME: tempHome() } });
    expect(text.split("\n")[0]).toBe("outsrc streams [--thread <id>] [--port <n>] [--recent-minutes <n>] [--no-open]");
    expect(text).toContain("never calls a vendor CLI or a model");
  }
  const top = execFileSync(process.execPath, ["--import", "tsx", cli, "--help"], { cwd, encoding: "utf8" });
  expect(top).toContain("streams [--thread <id>]");
});
