import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { pidAlive } from "./job.js";
import { threadsDir } from "./paths.js";
import { ProcessSchema, readJson, readResult, RunSchema, ThreadSchema } from "./state.js";
import { MINTED_THREAD_ID, STORAGE_ID, type ThreadId } from "./types.js";

// The viewer only reads the files jobs already write. It never writes state, starts a process, or calls a vendor CLI,
// so watching costs no tokens and cannot change what send or inbox report.

// "stopped": the wrapper is gone without a result. `outsrc threads` or `inbox` records that as failed; the viewer does not.
export type StreamStatus = "working" | "needs_input" | "succeeded" | "failed" | "cancelled" | "stopped";
export type StreamPane = {
  thread_id: ThreadId;
  repo: string;
  target: string;
  branch: string;
  status: StreamStatus;
  live: boolean;
  created_at: string;
  run_id: string;
  run_started_at: string;
  finished_at: string | null;
  log_size: number;
};

type Cached = { mtimeMs: number; pane: StreamPane };
export type Scanner = (now?: number) => StreamPane[];

export const INITIAL_TAIL_BYTES = 64 * 1024;
const MAX_CHUNK_BYTES = 256 * 1024;

function logSize(file: string): number {
  try { return statSync(file).size; } catch { return 0; }
}

function readPane(home: string, id: ThreadId): StreamPane | null {
  const dir = join(threadsDir(home), id);
  const thread = ThreadSchema.safeParse(readJson(join(dir, "thread.json")));
  if (!thread.success || !STORAGE_ID.test(thread.data.latestRunId)) return null;
  const runDir = join(dir, "runs", thread.data.latestRunId);
  const run = RunSchema.safeParse(readJson(join(runDir, "run.json")));
  if (!run.success) return null;
  const result = readResult(runDir);
  let status: StreamStatus;
  if (result) status = result.kind === "completed" ? "succeeded" : result.kind;
  else if (existsSync(join(runDir, "cancelled"))) status = "cancelled";
  else {
    const file = join(runDir, "process.json");
    const recorded = existsSync(file) ? ProcessSchema.safeParse(readJson(file)) : null;
    status = recorded && (!recorded.success || !pidAlive(recorded.data.pid)) ? "stopped" : "working";
  }
  return {
    thread_id: thread.data.id, repo: thread.data.repo, target: thread.data.target, branch: thread.data.branch,
    status, live: status === "working", created_at: thread.data.createdAt, run_id: run.data.id,
    run_started_at: run.data.createdAt, finished_at: result?.finishedAt ?? null, log_size: logSize(join(runDir, "run.log")),
  };
}

/**
 * Returns a scanner over `<home>/threads`. Working threads are always listed; finished ones only if they finished
 * within `recentMs`, or if they are the pinned `thread`. A finished thread whose thread.json has not changed is not
 * reread, so each tick costs one stat per old thread.
 */
export function createScanner(input: { home: string; thread?: ThreadId; recentMs: number }): Scanner {
  const cache = new Map<string, Cached>();
  return (now = Date.now()) => {
    const root = threadsDir(input.home);
    let names: string[];
    try { names = readdirSync(root); } catch { names = []; }
    if (input.thread) names = names.filter((name) => name === input.thread);
    const seen = new Set<string>();
    const panes: StreamPane[] = [];
    for (const name of names) {
      if (!MINTED_THREAD_ID.test(name)) continue;
      seen.add(name);
      let mtimeMs: number;
      try { mtimeMs = statSync(join(root, name, "thread.json")).mtimeMs; } catch { continue; }
      const cached = cache.get(name);
      let pane: StreamPane | null;
      if (cached && cached.mtimeMs === mtimeMs && !cached.pane.live && cached.pane.status !== "stopped" && cached.pane.status !== "needs_input") pane = cached.pane;
      else {
        try { pane = readPane(input.home, name as ThreadId); } catch { pane = null; }
        if (!pane) continue;
        cache.set(name, { mtimeMs, pane });
      }
      const recent = pane.finished_at !== null && now - Date.parse(pane.finished_at) < input.recentMs;
      if (pane.live || pane.status === "needs_input" || pane.status === "stopped" || recent || input.thread) panes.push(pane);
    }
    for (const name of cache.keys()) if (!seen.has(name)) cache.delete(name);
    return panes.sort((a, b) => Number(b.live) - Number(a.live) || b.created_at.localeCompare(a.created_at) || a.thread_id.localeCompare(b.thread_id));
  };
}

/** Reads a run log from `offset`. `reset` is true when the file shrank or the caller asks for the first read. */
export function readLogFrom(home: string, pane: Pick<StreamPane, "thread_id" | "run_id">, offset: number | null): { text: string; next: number; reset: boolean } {
  const file = join(threadsDir(home), pane.thread_id, "runs", pane.run_id, "run.log");
  const size = logSize(file);
  const reset = offset === null || size < offset;
  const start = reset ? Math.max(0, size - INITIAL_TAIL_BYTES) : offset;
  const length = Math.min(size - start, MAX_CHUNK_BYTES);
  if (length <= 0) return { text: "", next: start, reset };
  const buffer = Buffer.alloc(length);
  const fd = openSync(file, "r");
  try { readSync(fd, buffer, 0, length, start); } finally { closeSync(fd); }
  // Hold back a split UTF-8 sequence at the end so it is sent whole with the next chunk.
  let end = length;
  for (let back = 1; back <= Math.min(3, length); back++) {
    const byte = buffer[length - back] ?? 0;
    if ((byte & 0xc0) === 0x80) continue;
    const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    if (width > back) end = length - back;
    break;
  }
  return { text: buffer.subarray(0, end).toString("utf8"), next: start + end, reset };
}

type Client = { res: ServerResponse; offsets: Map<string, { runId: string; offset: number }>; lastList: string };

export type StreamServer = { url: string; port: number; token: string; close(): Promise<void>; clients(): number };

export async function startStreamServer(input: {
  home: string;
  thread?: ThreadId;
  host?: string;
  port?: number;
  pollMs?: number;
  recentMs?: number;
  token?: string;
}): Promise<StreamServer> {
  const host = input.host ?? "127.0.0.1";
  const token = input.token ?? randomBytes(16).toString("hex");
  const pollMs = Math.min(input.pollMs ?? 1000, 1000);
  const scan = createScanner({ home: input.home, recentMs: input.recentMs ?? 15 * 60_000, ...(input.thread ? { thread: input.thread } : {}) });
  const clients = new Set<Client>();
  let timer: NodeJS.Timeout | null = null;
  let heartbeat = 0;

  function send(client: Client, event: string, data: unknown): void {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  function tick(): void {
    const panes = scan();
    const listed = panes.map(({ log_size: _size, ...pane }) => pane);
    const listing = JSON.stringify(listed);
    for (const client of clients) {
      if (listing !== client.lastList) {
        send(client, "threads", { home: input.home, pinned: input.thread ?? null, now: new Date().toISOString(), threads: listed });
        client.lastList = listing;
      }
      for (const pane of panes) {
        const known = client.offsets.get(pane.thread_id);
        const sameRun = known?.runId === pane.run_id;
        if (sameRun && known.offset === pane.log_size) continue;
        const chunk = readLogFrom(input.home, pane, sameRun ? known.offset : null);
        client.offsets.set(pane.thread_id, { runId: pane.run_id, offset: chunk.next });
        if (chunk.text || chunk.reset) send(client, "log", { thread_id: pane.thread_id, run_id: pane.run_id, text: chunk.text, reset: chunk.reset });
      }
    }
    // A comment line every 15s keeps proxies and browsers from dropping an idle stream.
    if (++heartbeat * pollMs >= 15_000) {
      heartbeat = 0;
      for (const client of clients) client.res.write(": keepalive\n\n");
    }
  }
  // Polling runs only while a browser is connected; with no viewer the process just holds a listening socket.
  function schedule(): void {
    if (clients.size > 0 && !timer) timer = setInterval(tick, pollMs);
    if (clients.size === 0 && timer) { clearInterval(timer); timer = null; }
  }

  function authorized(req: IncomingMessage, url: URL): boolean {
    // Rejecting other Host headers stops a web page from reading the stream through DNS rebinding.
    const hostHeader = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (hostHeader !== "127.0.0.1" && hostHeader !== "localhost" && hostHeader !== "[::1]") return false;
    return url.searchParams.get("token") === token;
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method !== "GET" || !authorized(req, url)) {
      res.writeHead(403, { "content-type": "text/plain" }).end("forbidden\n");
      return;
    }
    if (url.pathname === "/") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
        "referrer-policy": "no-referrer",
      }).end(PAGE);
      return;
    }
    if (url.pathname === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write("retry: 1000\n\n");
      const client: Client = { res, offsets: new Map(), lastList: "" };
      clients.add(client);
      req.on("close", () => { clients.delete(client); schedule(); });
      schedule();
      tick();
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.port ?? 0, host, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://${host}:${port}/?token=${token}`,
    port,
    token,
    clients: () => clients.size,
    close: () => new Promise<void>((resolve) => {
      if (timer) clearInterval(timer);
      timer = null;
      for (const client of clients) client.res.end();
      clients.clear();
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>outsrc streams</title>
<style>
  :root { color-scheme: dark; --bg: #0d1014; --pane: #151a21; --line: #262d38; --text: #d7dde5; --dim: #7c8796; --live: #3fb950; --wait: #d29922; --bad: #f85149; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
  header.top { display: flex; gap: 16px; align-items: baseline; padding: 10px 14px; border-bottom: 1px solid var(--line); }
  header.top h1 { font-size: 14px; margin: 0; }
  header.top .meta { color: var(--dim); }
  #conn.down { color: var(--bad); }
  #grid { display: grid; gap: 10px; padding: 10px; grid-template-columns: repeat(auto-fill, minmax(520px, 1fr)); }
  .pane { display: flex; flex-direction: column; height: 46vh; min-height: 240px; background: var(--pane); border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
  .pane .head { display: flex; gap: 10px; align-items: center; padding: 6px 10px; border-bottom: 1px solid var(--line); white-space: nowrap; overflow: hidden; }
  .pane .id { font-weight: 600; }
  .pane .dim { color: var(--dim); overflow: hidden; text-overflow: ellipsis; }
  .pane .status { padding: 0 6px; border-radius: 4px; border: 1px solid currentColor; font-size: 11px; }
  .status.working { color: var(--live); }
  .status.needs_input, .status.stopped { color: var(--wait); }
  .status.failed, .status.cancelled { color: var(--bad); }
  .status.succeeded { color: var(--dim); }
  .pane .spacer { flex: 1; }
  .pane .paused { display: none; cursor: pointer; color: var(--wait); }
  .pane.is-paused .paused { display: inline; }
  .pane pre { flex: 1; margin: 0; padding: 8px 10px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
  #strip { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 10px 10px; }
  #strip:empty { display: none; }
  #strip .done { opacity: .55; background: var(--pane); border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; cursor: pointer; }
  #strip .done:hover { opacity: .9; }
  .pane.muted { opacity: .6; }
  #empty { padding: 40px 14px; color: var(--dim); }
</style>
</head>
<body>
<header class="top"><h1>outsrc streams</h1><span class="meta" id="home"></span><span class="meta" id="conn">connecting</span></header>
<div id="empty" hidden>No working threads. Watching for new ones.</div>
<div id="grid"></div>
<div id="strip"></div>
<script>
"use strict";
const MAX_CHARS = 200000;
const token = new URLSearchParams(location.search).get("token") || "";
const grid = document.getElementById("grid");
const strip = document.getElementById("strip");
const empty = document.getElementById("empty");
const conn = document.getElementById("conn");
const panes = new Map();
const expanded = new Set();
let threads = [];
let skew = 0;

function age(iso) {
  const s = Math.max(0, Math.floor((Date.now() + skew - Date.parse(iso)) / 1000));
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m" + String(s % 60).padStart(2, "0") + "s";
  return Math.floor(s / 3600) + "h" + String(Math.floor(s / 60) % 60).padStart(2, "0") + "m";
}
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}
function makePane(t) {
  const root = el("section", "pane");
  const head = el("div", "head");
  const id = el("span", "id", t.thread_id.slice(0, 8));
  id.title = t.thread_id;
  const status = el("span", "status");
  const target = el("span", "", "");
  const branch = el("span", "dim", "");
  const spacer = el("span", "spacer");
  const paused = el("span", "paused", "paused, click to follow");
  const ageEl = el("span", "dim", "");
  head.append(id, target, status, branch, spacer, paused, ageEl);
  const body = el("pre", "");
  root.append(head, body);
  const pane = { root, status, target, branch, age: ageEl, body, follow: true, runId: null, t };
  body.addEventListener("scroll", () => {
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
    pane.follow = atBottom;
    root.classList.toggle("is-paused", !atBottom);
  });
  paused.addEventListener("click", () => { pane.follow = true; root.classList.remove("is-paused"); body.scrollTop = body.scrollHeight; });
  return pane;
}
function paneFor(t) {
  let pane = panes.get(t.thread_id);
  if (!pane) { pane = makePane(t); panes.set(t.thread_id, pane); }
  pane.t = t;
  pane.status.className = "status " + t.status;
  pane.status.textContent = t.status;
  pane.target.textContent = t.target;
  pane.branch.textContent = t.branch;
  pane.root.classList.toggle("muted", !t.live);
  return pane;
}
function render() {
  const shown = threads.filter((t) => t.live || expanded.has(t.thread_id));
  const done = threads.filter((t) => !t.live && !expanded.has(t.thread_id));
  const keep = new Set(shown.map((t) => t.thread_id));
  for (const [id, pane] of panes) if (!keep.has(id)) pane.root.remove();
  shown.forEach((t, index) => {
    const pane = paneFor(t);
    if (grid.children[index] !== pane.root) grid.insertBefore(pane.root, grid.children[index] || null);
  });
  strip.replaceChildren(...done.map((t) => {
    paneFor(t);
    const chip = el("span", "done", t.thread_id.slice(0, 8) + " " + t.target + " " + t.status + " " + age(t.finished_at || t.run_started_at) + " ago");
    chip.title = t.branch + " (click to show log)";
    chip.addEventListener("click", () => { expanded.add(t.thread_id); render(); });
    return chip;
  }));
  empty.hidden = threads.some((t) => t.live);
  tickAges();
}
function tickAges() {
  for (const t of threads) {
    const pane = panes.get(t.thread_id);
    if (pane) pane.age.textContent = t.live ? age(t.run_started_at) : "done " + age(t.finished_at || t.run_started_at) + " ago";
  }
}
function append(msg) {
  const pane = panes.get(msg.thread_id);
  if (!pane) return;
  if (msg.reset || pane.runId !== msg.run_id) { pane.body.textContent = ""; pane.runId = msg.run_id; }
  let text = pane.body.textContent + msg.text;
  if (text.length > MAX_CHARS) text = text.slice(text.length - MAX_CHARS);
  pane.body.textContent = text;
  if (pane.follow) pane.body.scrollTop = pane.body.scrollHeight;
}
function connect() {
  const source = new EventSource("/events?token=" + encodeURIComponent(token));
  source.onopen = () => { conn.textContent = "live"; conn.className = "meta"; };
  source.onerror = () => { conn.textContent = "disconnected, retrying"; conn.className = "meta down"; };
  source.addEventListener("threads", (event) => {
    const data = JSON.parse(event.data);
    skew = Date.parse(data.now) - Date.now();
    document.getElementById("home").textContent = data.home;
    threads = data.threads;
    if (data.pinned) expanded.add(data.pinned);
    render();
  });
  source.addEventListener("log", (event) => append(JSON.parse(event.data)));
}
setInterval(tickAges, 1000);
connect();
</script>
</body>
</html>
`;
