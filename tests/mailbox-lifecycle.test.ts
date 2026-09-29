import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { createMailbox, requestFileName, type Mailbox } from "../src/mailbox.ts";
import { ResultSchema, RunSchema, ThreadSchema, writeJson } from "../src/state.ts";
import { parseAlias, parseTargetName, parseThreadId, type MailboxContext, type RunRecord, type SendInput, type ThreadRecord } from "../src/types.ts";
import { initGitRepo, tempHome } from "./helpers.ts";

function fixture() {
  const home = tempHome();
  const repo = join(home, "repo");
  initGitRepo(repo);
  const script = join(home, "session-agent.mjs");
  writeFileSync(script, `
import {appendFileSync} from 'node:fs';
const prompt=process.argv.at(-1);
if(prompt.startsWith('Slow task'))await new Promise(resolve=>setTimeout(resolve,1000));
appendFileSync('turns.ndjson',JSON.stringify({session:process.argv[3],model:process.argv[5],effort:process.argv[7]})+'\\n');
process.stdout.write(JSON.stringify({kind:prompt.startsWith('Question task')?'needs_input':'completed',message:'Turn complete',sessionId:'saved-session',findings:[]}));
`);
  const ctx: MailboxContext = {
    home,
    config: {
      repos: [{ alias: "demo", path: repo }],
      targets: {
        fake: {
          adapter: "custom",
          command: process.execPath,
          args: [script, "--session", "{session_id}", "--model", "{model}", "--effort", "{effort}"],
          models: { default: "model-one", allowed: ["model-one", "model-two"] },
          effort: { default: "low", allowed: ["low", "high"] },
        },
      },
    },
  };
  return { home, ctx, box: createMailbox(ctx) };
}

async function complete(box: Mailbox, threadId: string) {
  await expect.poll(() => {
    const status = box.inbox(threadId);
    return status.ok ? status.status : status.error;
  }, { timeout: 5000 }).toBe("succeeded");
}

async function start(box: Mailbox) {
  const sent = await box.send({ repo: "demo", target: "fake", message: "Initial task" });
  if (!sent.ok) throw new Error(sent.error);
  await complete(box, sent.thread_id);
  return sent;
}

function exitedOwner(): number {
  const owner = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  expect(owner.status).toBe(0);
  return owner.pid;
}

function interruptedRequest(input: {
  home: string;
  request: SendInput & { request_id: string };
  thread: ThreadRecord;
  ownerPid: number;
}) {
  const request = input.request;
  const fingerprint = createHash("sha256").update(JSON.stringify({
    message: request.message, repo: request.repo, target: request.target, thread: request.thread_id,
    model: request.model, effort: request.effort, kind: request.kind,
  })).digest("hex");
  const run: RunRecord = {
    id: "interrupted-run", threadId: input.thread.id, requestId: request.request_id,
    message: request.message, createdAt: new Date().toISOString(), sessionId: request.thread_id ? "saved-session" : null,
  };
  const directory = join(input.home, "requests");
  mkdirSync(directory, { recursive: true });
  writeJson(join(directory, requestFileName(undefined, request.request_id)), {
    fingerprint, threadId: input.thread.id, runId: run.id,
    preparation: { ownerPid: input.ownerPid, previousRunId: input.thread.latestRunId, thread: { ...input.thread, latestRunId: run.id }, run },
  });
  return run;
}

function preparingThread(home: string): ThreadRecord {
  const threadId = parseThreadId("abcdef0123456789");
  return {
    version: 2, id: threadId, caller: "local", repo: parseAlias("demo"), target: parseTargetName("fake"),
    model: "model-one", effort: "low", taskKind: "task", base: null,
    worktree: join(home, "worktrees", "demo", threadId), branch: `agent/outsrc-${threadId}`,
    baseCommit: "", createdAt: new Date().toISOString(), latestRunId: "",
  };
}

describe("mailbox lifecycle", () => {
  test("increases polling delays with run age and caps them at five minutes", async () => {
    const { box, home } = fixture();
    const sent = await box.send({ repo: "demo", target: "fake", message: "Slow task" });
    if (!sent.ok) throw new Error(sent.error);
    const run = RunSchema.parse(JSON.parse(readFileSync(join(home, "threads", sent.thread_id, "runs", sent.run_id, "run.json"), "utf8")));
    const clock = vi.spyOn(Date, "now");
    try {
      for (const { age, delay } of [
        { age: 0, delay: 30 }, { age: 120_000, delay: 60 },
        { age: 240_000, delay: 120 }, { age: 360_000, delay: 240 },
        { age: 480_000, delay: 300 }, { age: 3_600_000, delay: 300 },
      ]) {
        clock.mockReturnValue(Date.parse(run.createdAt) + age);
        expect(box.inbox(sent.thread_id)).toMatchObject({ status: "working", retry_after_seconds: delay });
      }
    } finally {
      clock.mockRestore();
    }
    await complete(box, sent.thread_id);
  });

  test("retains the provider session after a continuation startup failure", async () => {
    const { box, ctx, home } = fixture();
    const initial = await start(box);
    const broken = createMailbox({ ...ctx, wrapperCommand: [join(home, "missing-wrapper")] });
    const attempted = await broken.send({ thread_id: initial.thread_id, message: "Continue" });
    expect(attempted).toMatchObject({ ok: true, delivered: true, thread_id: initial.thread_id });
    expect(broken.inbox(initial.thread_id)).toMatchObject({ status: "failed", session_id: "saved-session", message: expect.stringContaining("ENOENT") });
    const restarted = createMailbox(ctx);
    const resumed = await restarted.send({ thread_id: initial.thread_id, message: "Retry continuation" });
    expect(resumed).toMatchObject({ ok: true, delivered: true, thread_id: initial.thread_id });
    await complete(restarted, initial.thread_id);
  });

  test("rejects continuation of a discarded thread without replacing its saved result", async () => {
    const { box } = fixture();
    const initial = await start(box);
    const before = box.inbox(initial.thread_id);
    expect(box.discard(initial.thread_id)).toMatchObject({ ok: true, discarded: true });
    const attempted = await box.send({ thread_id: initial.thread_id, message: "Continue" });
    expect(attempted).toMatchObject({ ok: false, error: expect.stringContaining("discarded") });
    expect(box.inbox(initial.thread_id)).toEqual(before);
  });

  test("launches one of two concurrent continuations", async () => {
    const { box, home } = fixture();
    const initial = await start(box);
    const responses = await Promise.all([
      box.send({ thread_id: initial.thread_id, message: "Continue A" }),
      box.send({ thread_id: initial.thread_id, message: "Continue B" }),
    ]);
    expect(responses.filter((result) => result.ok)).toHaveLength(1);
    expect(responses.filter((result) => !result.ok)).toEqual([{ ok: false, error: "thread is still working" }]);
    await complete(box, initial.thread_id);
    const turns = readFileSync(join(home, "worktrees", "demo", initial.thread_id, "turns.ndjson"), "utf8").trim().split("\n").map((line): unknown => JSON.parse(line));
    expect(turns).toEqual([
      { session: "", model: "model-one", effort: "low" },
      { session: "saved-session", model: "model-one", effort: "low" },
    ]);
  });

  test("restores stored options and skips setup when continuing after restart", async () => {
    const { box, ctx, home } = fixture();
    const repo = ctx.config.repos[0];
    const target = ctx.config.targets.fake;
    if (!repo || !target) throw new Error("fixture configuration missing");
    repo.setup = [[process.execPath, "-e", "require('node:fs').appendFileSync('setup.txt','setup\\n')"]];
    const initial = await start(box);
    target.models = { default: "model-two", allowed: ["model-one", "model-two"] };
    target.effort = { default: "high", allowed: ["low", "high"] };
    const restarted = createMailbox(ctx);
    const resumed = await restarted.send({ thread_id: initial.thread_id, message: "Continue after restart" });
    if (!resumed.ok) throw new Error(resumed.error);
    await complete(restarted, initial.thread_id);
    const workspace = join(home, "worktrees", "demo", initial.thread_id);
    expect(readFileSync(join(workspace, "setup.txt"), "utf8")).toBe("setup\n");
    const turns = readFileSync(join(workspace, "turns.ndjson"), "utf8").trim().split("\n").map((line): unknown => JSON.parse(line));
    expect(turns).toEqual([
      { session: "", model: "model-one", effort: "low" },
      { session: "saved-session", model: "model-one", effort: "low" },
    ]);
    expect(restarted.inbox(initial.thread_id)).toMatchObject({ status: "succeeded", run_id: resumed.run_id, session_id: "saved-session" });
  });

  test("replays a successful request receipt after restart without running it twice", async () => {
    const { box, ctx, home } = fixture();
    const input = { repo: "demo", target: "fake", message: "Retryable task", request_id: "same-delivery" };
    const first = await box.send(input);
    if (!first.ok) throw new Error(first.error);
    await complete(box, first.thread_id);
    const restarted = createMailbox(ctx);
    expect(await restarted.send(input)).toEqual(first);
    expect(readFileSync(join(home, "worktrees", "demo", first.thread_id, "turns.ndjson"), "utf8")).toBe('{"session":"","model":"model-one","effort":"low"}\n');
    expect(restarted.threads().threads).toMatchObject([{ thread_id: first.thread_id, run_count: 1, status: "succeeded" }]);
  });

  test("replays the same accepted delivery after a wrapper startup failure", async () => {
    const { ctx, home } = fixture();
    const broken = createMailbox({ ...ctx, wrapperCommand: [join(home, "missing-wrapper")] });
    const input = { repo: "demo", target: "fake", message: "Attempt startup", request_id: "failed-startup" };
    const first = await broken.send(input);
    expect(first).toMatchObject({ ok: true, delivered: true });
    if (!first.ok) throw new Error(first.error);
    const failed = broken.inbox(first.thread_id);
    expect(failed).toMatchObject({ status: "failed", message: expect.stringContaining("ENOENT") });
    const restarted = createMailbox(ctx);
    expect(await restarted.send(input)).toEqual(first);
    expect(restarted.inbox(first.thread_id)).toEqual(failed);
    expect(restarted.threads().threads).toMatchObject([{ thread_id: first.thread_id, run_count: 1, status: "failed" }]);
  });

  test("recovers a launch lock left by an exited owner", async () => {
    const { box, ctx, home } = fixture();
    const initial = await start(box);
    const owner = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    expect(owner.status).toBe(0);
    writeFileSync(join(home, "threads", initial.thread_id, "launch.lock"), String(owner.pid));
    const restarted = createMailbox(ctx);
    const resumed = await restarted.send({ thread_id: initial.thread_id, message: "Continue after interrupted launcher" });
    expect(resumed).toMatchObject({ ok: true, delivered: true, thread_id: initial.thread_id });
    await complete(restarted, initial.thread_id);
    expect(restarted.threads().threads).toMatchObject([{ thread_id: initial.thread_id, run_count: 2, status: "succeeded" }]);
  });

  test("prunes expired completed work and preserves current, active, and waiting threads", async () => {
    const { box, ctx, home } = fixture();
    const repo = ctx.config.repos[0];
    if (!repo) throw new Error("fixture repository missing");
    repo.retentionDays = 1;
    const expired = await start(box);
    const expiredFile = join(home, "threads", expired.thread_id, "runs", expired.run_id, "result.json");
    const result = ResultSchema.parse(JSON.parse(readFileSync(expiredFile, "utf8")));
    result.finishedAt = new Date(Date.now() - 2 * 86400_000).toISOString();
    writeJson(expiredFile, result);
    const current = await start(box);
    const waiting = await box.send({ repo: "demo", target: "fake", message: "Question task" });
    if (!waiting.ok) throw new Error(waiting.error);
    await expect.poll(() => box.inbox(waiting.thread_id)).toMatchObject({ status: "needs_input" });
    const active = await box.send({ repo: "demo", target: "fake", message: "Slow task" });
    if (!active.ok) throw new Error(active.error);
    expect(box.inbox(active.thread_id)).toMatchObject({ status: "working" });
    expect(box.prune()).toEqual({ removed: [expired.thread_id] });
    expect(existsSync(join(home, "worktrees", "demo", expired.thread_id))).toBe(false);
    expect(execFileSync("git", ["branch", "--list", `agent/outsrc-${expired.thread_id}`], { cwd: repo.path, encoding: "utf8" })).toBe("");
    expect(box.inbox(expired.thread_id)).toMatchObject({ status: "succeeded", message: "Turn complete" });
    for (const preserved of [current, waiting, active]) {
      expect(readFileSync(join(home, "worktrees", "demo", preserved.thread_id, "README.md"), "utf8")).toBe("fixture\n");
    }
    expect(box.inbox(current.thread_id)).toMatchObject({ status: "succeeded" });
    expect(box.inbox(waiting.thread_id)).toMatchObject({ status: "needs_input" });
    expect(box.inbox(active.thread_id)).toMatchObject({ status: "working" });
    expect(box.prune()).toEqual({ removed: [] });
    await complete(box, active.thread_id);
  });

  test("recovers an interrupted first submission without executing it twice", async () => {
    const { ctx, home } = fixture();
    const request = { repo: "demo", target: "fake", message: "Interrupted delivery", request_id: "interrupted-first" };
    const thread = preparingThread(home);
    const run = interruptedRequest({ home, request, thread, ownerPid: exitedOwner() });
    const restarted = createMailbox(ctx);
    const first = await restarted.send(request);
    expect(first).toEqual({ ok: true, delivered: true, thread_id: thread.id, run_id: run.id });
    const failed = restarted.inbox(thread.id);
    expect(failed).toMatchObject({
      status: "failed", run_id: "interrupted-run", exit_code: null,
      message: "Submission was interrupted before the wrapper started; retry with a new request_id",
    });
    expect(await createMailbox(ctx).send(request)).toEqual(first);
    expect(createMailbox(ctx).inbox(thread.id)).toEqual(failed);
    expect(restarted.threads().threads).toMatchObject([{ thread_id: thread.id, run_count: 1, status: "failed" }]);
    expect(existsSync(thread.worktree)).toBe(false);
  });

  test("recovers a submission whose worktree setup was interrupted", async () => {
    const { ctx, home } = fixture();
    const request = { repo: "demo", target: "fake", message: "Interrupted worktree", request_id: "partial-worktree" };
    const thread = preparingThread(home);
    thread.baseCommit = "";
    mkdirSync(thread.worktree, { recursive: true });
    const run = interruptedRequest({ home, request, thread, ownerPid: exitedOwner() });
    const restarted = createMailbox(ctx);
    expect(await restarted.send(request)).toEqual({ ok: true, delivered: true, thread_id: thread.id, run_id: run.id });
    expect(restarted.inbox(thread.id)).toMatchObject({ status: "failed", message: "Submission was interrupted before the wrapper started; retry with a new request_id" });
    expect(restarted.diff({ thread_id: thread.id })).toEqual({ ok: false, error: "No starting commit was recorded because task setup did not finish" });
    expect(restarted.discard(thread.id)).toMatchObject({ ok: true, discarded: true });
    expect(existsSync(thread.worktree)).toBe(false);
  });

  test("keeps a live preparation pending instead of publishing delivery", async () => {
    const { ctx, home } = fixture();
    const request = { repo: "demo", target: "fake", message: "Preparing delivery", request_id: "still-preparing" };
    const thread = preparingThread(home);
    interruptedRequest({ home, request, thread, ownerPid: process.pid });
    const restarted = createMailbox(ctx);
    expect(await restarted.send(request)).toEqual({ ok: false, error: "request is still preparing; retry the same request_id" });
    expect(restarted.threads()).toEqual({ threads: [] });
  });

  test("recovering an old interrupted request preserves a newer completed continuation", async () => {
    const { box, ctx, home } = fixture();
    const initial = await start(box);
    const thread = ThreadSchema.parse(JSON.parse(readFileSync(join(home, "threads", initial.thread_id, "thread.json"), "utf8")));
    const request = { thread_id: thread.id, message: "Interrupted continuation", request_id: "old-interrupted-resume" };
    const interrupted = interruptedRequest({ home, request, thread, ownerPid: exitedOwner() });
    const newer = await box.send({ thread_id: thread.id, message: "A newer continuation" });
    if (!newer.ok) throw new Error(newer.error);
    await complete(box, thread.id);
    const completed = box.inbox(thread.id);
    const restarted = createMailbox(ctx);
    expect(await restarted.send(request)).toEqual({ ok: true, delivered: true, thread_id: thread.id, run_id: interrupted.id });
    expect(restarted.inbox(thread.id)).toEqual(completed);
    const recovered = ResultSchema.parse(JSON.parse(readFileSync(join(home, "threads", thread.id, "runs", interrupted.id, "result.json"), "utf8")));
    expect(recovered).toMatchObject({ kind: "failed", sessionId: "saved-session", message: "Submission was interrupted before the wrapper started; retry with a new request_id" });
  });

  test("recovers a continuation interrupted between writing its run and advancing its thread", async () => {
    const { box, ctx, home } = fixture();
    const initial = await start(box);
    const thread = ThreadSchema.parse(JSON.parse(readFileSync(join(home, "threads", initial.thread_id, "thread.json"), "utf8")));
    const request = { thread_id: thread.id, message: "Partly recorded continuation", request_id: "partial-records" };
    const interrupted = interruptedRequest({ home, request, thread, ownerPid: exitedOwner() });
    const directory = join(home, "threads", thread.id, "runs", interrupted.id);
    mkdirSync(directory, { recursive: true });
    writeJson(join(directory, "run.json"), interrupted);
    const restarted = createMailbox(ctx);
    expect(await restarted.send(request)).toEqual({ ok: true, delivered: true, thread_id: thread.id, run_id: interrupted.id });
    expect(restarted.inbox(thread.id)).toMatchObject({
      status: "failed", run_id: interrupted.id, session_id: "saved-session",
      message: "Submission was interrupted before the wrapper started; retry with a new request_id",
    });
    const resumed = await restarted.send({ thread_id: thread.id, message: "Retry after recovery" });
    expect(resumed).toMatchObject({ ok: true, delivered: true });
    await complete(restarted, thread.id);
  });

  test("persists one cancellation timestamp so retention can expire it", async () => {
    const { box, ctx, home } = fixture();
    const repo = ctx.config.repos[0];
    if (!repo) throw new Error("fixture repository missing");
    repo.retentionDays = 1;
    const initial = await start(box);
    const directory = join(home, "threads", initial.thread_id, "runs", initial.run_id);
    rmSync(join(directory, "result.json"));
    writeFileSync(join(directory, "cancelled"), "1");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
      expect(box.inbox(initial.thread_id)).toMatchObject({ status: "cancelled", message: "Task cancelled" });
      const first = ResultSchema.parse(JSON.parse(readFileSync(join(directory, "result.json"), "utf8")));
      expect(first.finishedAt).toBe("2030-01-01T00:00:00.000Z");
      vi.setSystemTime(new Date("2030-01-03T00:00:00.000Z"));
      const restarted = createMailbox(ctx);
      expect(restarted.inbox(initial.thread_id)).toMatchObject({ status: "cancelled", message: "Task cancelled" });
      expect(ResultSchema.parse(JSON.parse(readFileSync(join(directory, "result.json"), "utf8"))).finishedAt).toBe("2030-01-01T00:00:00.000Z");
      expect(restarted.prune()).toEqual({ removed: [initial.thread_id] });
      expect(restarted.prune()).toEqual({ removed: [] });
    } finally {
      vi.useRealTimers();
    }
  });
});
