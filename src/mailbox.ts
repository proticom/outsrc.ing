import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync, chmodSync } from "node:fs";
import { ensureOutsrcHome, writeHomeFile } from "./fs-home.js";
import { join } from "node:path";
import { z } from "zod";
import { buildInvocation, type AdapterTarget } from "./adapters.js";
import { addWorktree, hideAgentConfig } from "./git.js";
import { commandExists, JOB_MARKER, jobEnv, pidAlive, processIdentity, sameProcess, startWrapper, stopOwnedProcess, type ProcessRecord } from "./job.js";
import { MAX_LOG_READ_BYTES, resolveLimits } from "./limits.js";
import { branchName, filesystemPath, resolveInside, threadDir, threadsDir, worktreePath } from "./paths.js";
import { isVerified, pluginVersion } from "./plugin-contract.js";
import { cancelInvocation, engineDir, isPluginAdapter, teardownInvocation } from "./plugins.js";
import { wrapMessage } from "./prompt.js";
import { ProcessSchema, readJson, readResult, RunSchema, ThreadSchema, writeJson } from "./state.js";
import { collectWorkspaceDiff, getBaseCommit } from "./workspace.js";
import { DEFAULT_CALLER, MINTED_THREAD_ID, parseAlias, parseRunId, parseTargetName, parseThreadId, type InboxResult, type MailboxContext, type RunRecord, type RunResult, type RunSpec, type SendInput, type SendResult, type TargetConfig, type ThreadId, type ThreadRecord, type UsageFields } from "./types.js";
import { aggregateUsage, emptyUsage, type UsageSample } from "./usage.js";

function id(): string { return randomBytes(8).toString("hex"); }
function adapter(target: TargetConfig, name: string): AdapterTarget {
  const kind = target.adapter ?? (name === "claude" || name === "codex" || name === "grok" ? name : "custom");
  return { adapter: kind, command: target.command, args: target.args };
}
function verifyRef(repoPath: string, ref: string, field: string): void {
  const name = ref.trim();
  if (!name || name.startsWith("-")) throw new Error(`${field} must name a commit, branch or tag`);
  try { execFileSync("git", ["rev-parse", "--verify", "--quiet", `${name}^{commit}`], { cwd: repoPath, stdio: "pipe" }); }
  catch { throw new Error(`${field} does not resolve to a commit in the repository: ${name}`); }
}
function pluginStatus(target: AdapterTarget) {
  if (!isPluginAdapter(target.adapter) || !target.command) return {};
  const version = pluginVersion(target.command);
  const verified = isVerified(target.adapter, version);
  return {
    plugin_version: version, verified,
    ...(verified ? {} : { warning: `Plugin version ${version ?? "unknown"} has not passed outsrc's plugin smoke test; results may be unreliable.` }),
  };
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function failedResult(message: string, sessionId: string | null = null): RunResult {
  return { kind: "failed", message, sessionId, findings: [], exitCode: null, finishedAt: new Date().toISOString(), diffstat: "", commit: null, usage: emptyUsage() };
}
const RequestSchema = z.object({
  fingerprint: z.string(), threadId: z.string().transform(parseThreadId), runId: z.string().transform(parseRunId),
  preparation: z.object({ ownerPid: z.number(), previousRunId: z.string().optional(), thread: ThreadSchema, run: RunSchema }).optional(),
});
// Keyed by caller too, so one caller's request_id can never replay another caller's thread.
export function requestFileName(caller: string | undefined, requestId: string): string {
  return `${createHash("sha256").update(`${caller ?? ""}\0${requestId}`).digest("hex")}.json`;
}
const fingerprint = (input: SendInput) => createHash("sha256").update(JSON.stringify({
  message: input.message, repo: input.repo, target: input.target, thread: input.thread_id,
  model: input.model, effort: input.effort, kind: input.kind, base: input.base, ref: input.ref,
})).digest("hex");

export function createMailbox(ctx: MailboxContext) {
  function loadThread(raw: string): ThreadRecord {
    const threadId = parseThreadId(raw);
    const file = join(threadDir(ctx.home, threadId), "thread.json");
    if (!existsSync(file)) throw new Error(`unknown thread_id: ${threadId}`);
    const parsed = ThreadSchema.safeParse(readJson(file));
    if (!parsed.success) throw new Error(`thread ${threadId} uses the previous storage format; run outsrc migrate after legacy jobs finish. Its worktree is preserved`);
    // Another caller's thread answers exactly like a missing one, so callers cannot read, answer or even detect each other's work.
    if (ctx.caller !== undefined && parsed.data.caller !== ctx.caller) throw new Error(`unknown thread_id: ${threadId}`);
    return parsed.data;
  }
  function storedRunDir(threadId: ThreadId, runId: string): string {
    return resolveInside(threadDir(ctx.home, threadId), "runs", parseRunId(runId));
  }
  function readProcess(file: string): ProcessRecord | null {
    if (!existsSync(file)) return null;
    const parsed = ProcessSchema.safeParse(readJson(file));
    return parsed.success ? parsed.data : null;
  }
  function current(thread: ThreadRecord) {
    const dir = storedRunDir(thread.id, thread.latestRunId);
    const run = RunSchema.parse(readJson(join(dir, "run.json")));
    return { dir, run };
  }
  function resultFor(thread: ThreadRecord): RunResult | null {
    const { dir, run } = current(thread);
    // Observe the wrapper before reading its result. A wrapper seen as gone has already published anything it
    // will publish, so the read below cannot miss a result that lands between the two checks.
    const processFile = join(dir, "process.json");
    const started = existsSync(processFile);
    const recorded = readProcess(processFile);
    const identity = recorded ? processIdentity(recorded) : null;
    const alive = recorded !== null && (identity === "match" || (identity === "unknown" && pidAlive(recorded.pid)));
    const result = readResult(dir);
    if (result) return result;
    if (existsSync(join(dir, "cancelled"))) {
      const cancelled: RunResult = { ...failedResult("Task cancelled", run.sessionId), kind: "cancelled" };
      writeJson(join(dir, "result.json"), cancelled);
      return cancelled;
    }
    if (alive) return null;
    if (started) {
      const failed = failedResult("Agent wrapper stopped without publishing a result", run.sessionId);
      writeJson(join(dir, "result.json"), failed);
      return failed;
    }
    if (Date.now() - Date.parse(run.createdAt) < 30_000) return null;
    const failed = failedResult("Task startup was interrupted before the wrapper started", run.sessionId);
    writeJson(join(dir, "result.json"), failed);
    return failed;
  }
  function tail(dir: string, offset?: number, limit = MAX_LOG_READ_BYTES): string {
    const file = join(dir, "run.log");
    if (!existsSync(file)) return "";
    const bytes = readFileSync(file);
    const bounded = Number.isFinite(limit) ? Math.max(0, Math.min(Math.floor(limit), MAX_LOG_READ_BYTES)) : MAX_LOG_READ_BYTES;
    const start = offset ?? Math.max(0, bytes.length - bounded);
    const from = Math.max(0, Math.min(Math.floor(start), bytes.length));
    return bytes.subarray(from, from + bounded).toString("utf8");
  }
  function inbox(threadId: string): InboxResult {
    try {
      const thread = loadThread(threadId);
      const { dir, run } = current(thread);
      const result = resultFor(thread);
      const fields = usageFields(thread, result);
      if (!result) {
        const age = Math.max(0, Date.now() - Date.parse(run.createdAt));
        const retry = ctx.retryAfterSeconds ?? Math.min(300, 30 * 2 ** Math.floor(age / 120_000));
        return { ...fields, ok: true, status: "working", retry_after_seconds: retry, run_id: run.id, progress: tail(dir).trim().split("\n").slice(-4).join("\n") };
      }
      if (result.kind === "needs_input") return {
        ...fields, ok: true, status: "needs_input", retry_after_seconds: 0, run_id: run.id,
        message: result.message, question_id: run.id, session_id: result.sessionId,
      };
      return {
        ...fields, ok: true, status: result.kind === "completed" ? "succeeded" : result.kind,
        run_id: run.id, message: result.message, branch: thread.branch, worktree: thread.worktree,
        diffstat: { raw: result.diffstat }, exit_code: result.exitCode,
        session_id: result.sessionId, findings: result.findings, commit: result.commit,
      };
    } catch (error) { return { ok: false, error: errorMessage(error) }; }
  }
  function usageFields(thread: ThreadRecord, result: RunResult | null): UsageFields {
    const { model, effort, ...usage } = result?.usage ?? emptyUsage();
    return { target: thread.target, effort, model, usage };
  }
  function savedRuns(thread: ThreadRecord) {
    const root = join(threadDir(ctx.home, thread.id), "runs");
    return readdirSync(root).flatMap((runId) => {
      let directory: string;
      try { directory = storedRunDir(thread.id, runId); }
      catch { return []; }
      const run = RunSchema.parse(readJson(join(directory, "run.json")));
      return [{ run, result: readResult(directory) }];
    }).sort((a, b) => a.run.createdAt.localeCompare(b.run.createdAt));
  }
  function replayRequest(file: string, requestFingerprint: string): SendResult {
    const previous = RequestSchema.parse(readJson(file));
    if (previous.fingerprint !== requestFingerprint) throw new Error("request_id was already used for a different message");
    const directory = threadDir(ctx.home, previous.threadId);
    const savedRunDir = storedRunDir(previous.threadId, previous.runId);
    const savedThreadFile = join(directory, "thread.json");
    const savedThread = existsSync(savedThreadFile) ? ThreadSchema.parse(readJson(savedThreadFile)) : null;
    const linkPending = previous.preparation?.previousRunId !== undefined && savedThread?.latestRunId === previous.preparation.previousRunId;
    if (!savedThread || !existsSync(join(savedRunDir, "run.json")) || linkPending) {
      const preparation = previous.preparation;
      if (!preparation) throw new Error("request startup was interrupted; its earlier storage format needs manual recovery");
      if (pidAlive(preparation.ownerPid)) throw new Error("request is still preparing; retry the same request_id");
      mkdirSync(savedRunDir, { recursive: true, mode: 0o700 }); try { chmodSync(savedRunDir, 0o700); } catch {}
      writeJson(join(savedRunDir, "run.json"), preparation.run);
      writeJson(join(savedRunDir, "result.json"), failedResult("Submission was interrupted before the wrapper started; retry with a new request_id", preparation.run.sessionId));
      const threadFile = join(directory, "thread.json");
      const existing = existsSync(threadFile) ? ThreadSchema.parse(readJson(threadFile)) : null;
      if (!existing || existing.latestRunId === preparation.previousRunId) {
        writeJson(threadFile, preparation.thread);
      }
    }
    return { ok: true, delivered: true, thread_id: previous.threadId, run_id: previous.runId };
  }
  async function send(input: SendInput): Promise<SendResult> {
    let requestFile: string | null = null;
    let lockedThread: string | null = null;
    let runDir: string | null = null;
    let thread: ThreadRecord | null = null;
    let createdThreadDirectory: string | null = null;
    try {
      if (!input.message.trim()) throw new Error("message is required");
      if (process.env[JOB_MARKER]) throw new Error("outsrc jobs cannot send new work; only the caller that started the job can");
      const { maxJobs, maxRunMinutes } = resolveLimits(ctx.config.limits);
      const active = threads().threads.filter((item) => item.status === "working").length;
      if (maxJobs !== null && active >= maxJobs) throw new Error(`active job limit reached (${maxJobs}); the owner can change it with outsrc config set limits.max_jobs <n>`);
      const requestFingerprint = fingerprint(input);
      if (input.request_id) {
        const requests = join(ctx.home, "requests");
        mkdirSync(requests, { recursive: true, mode: 0o700 }); try { chmodSync(requests, 0o700); } catch {}
        requestFile = join(requests, requestFileName(ctx.caller, input.request_id));
        if (existsSync(requestFile)) {
          return replayRequest(requestFile, requestFingerprint);
        }
      }
      let sessionId: string | null = null;
      let first = false;
      if (input.thread_id) {
        thread = loadThread(input.thread_id);
        if (existsSync(join(threadDir(ctx.home, thread.id), "discarded"))) throw new Error("thread was discarded; start a new task");
        if (input.repo !== undefined || input.target !== undefined || input.model !== undefined || input.effort !== undefined || input.kind !== undefined || input.base !== undefined || input.ref !== undefined) throw new Error("continuations retain their repository, target and options; start a new task to change them");
        const result = resultFor(thread);
        if (!result) throw new Error("thread is still working");
        if (!result.sessionId) throw new Error("thread has no resumable session ID; start a new task");
        sessionId = result.sessionId;
      } else {
        if (!input.repo) throw new Error("repo is required");
        if (!input.target) throw new Error("target is required");
        const repo = parseAlias(input.repo);
        const target = parseTargetName(input.target);
        if (!ctx.config.repos.some((item) => item.alias === repo)) throw new Error(`unknown repo: ${repo}`);
        const targetConfig = ctx.config.targets[target];
        if (!targetConfig) throw new Error(`unknown target: ${target}`);
        if (input.model && targetConfig.models && !targetConfig.models.allowed.includes(input.model)) throw new Error(`model not allowed: ${input.model}`);
        if (input.effort && targetConfig.effort && !targetConfig.effort.allowed.includes(input.effort)) throw new Error(`effort not allowed: ${input.effort}`);
        const repoPath = ctx.config.repos.find((item) => item.alias === repo)?.path ?? "";
        if (input.base !== undefined) {
          if ((input.kind ?? "task") === "task") throw new Error("base applies only to review and adversarial_review");
          verifyRef(repoPath, input.base, "base");
        }
        if (input.ref !== undefined) verifyRef(repoPath, input.ref, "ref");
        const threadId = parseThreadId(id());
        thread = {
          version: 2, id: threadId, caller: ctx.caller ?? DEFAULT_CALLER, repo, target,
          model: input.model ?? targetConfig.models?.default ?? null,
          effort: input.effort ?? targetConfig.effort?.default ?? null,
          taskKind: input.kind ?? "task", base: input.base?.trim() ?? null, worktree: worktreePath(ctx.home, repo, threadId),
          branch: branchName(threadId), baseCommit: "", createdAt: new Date().toISOString(), latestRunId: "",
        };
        first = true;
      }
      const selectedRepo = thread.repo;
      const repo = ctx.config.repos.find((item) => item.alias === selectedRepo);
      const target = ctx.config.targets[thread.target];
      if (!repo || !target) throw new Error("thread repository or target is no longer configured");
      if (!commandExists(target.command)) throw new Error(`command not found: ${target.command}`);
      const runId = id();
      const run: RunRecord = { id: runId, threadId: thread.id, requestId: input.request_id ?? null, message: input.message.trim(), createdAt: new Date().toISOString(), sessionId };
      const directory = threadDir(ctx.home, thread.id);
      runDir = storedRunDir(thread.id, runId);
      const spec: RunSpec = {
        threadId: thread.id, runId, runDir, worktree: thread.worktree, baseCommit: thread.baseCommit,
        target: adapter(target, thread.target), model: thread.model, effort: thread.effort,
        permissions: target.permissions ?? "auto", sessionId,
        prompt: wrapMessage(input.message, thread.taskKind, isPluginAdapter(adapter(target, thread.target).adapter) ? "text" : "json"),
        // Setup commands run the checkout's own scripts (npm install hooks, for example); a review must not run them.
        setup: first && thread.taskKind === "task" ? repo.setup ?? [] : [], autoCommit: thread.taskKind === "task" && (repo.autoCommit ?? false),
        kind: thread.taskKind, base: thread.base,
        deadlineMs: maxRunMinutes === null ? null : maxRunMinutes * 60_000,
      };
      const selected = spec.target.adapter;
      buildInvocation({ ...spec, schemaPath: join(runDir, "output-schema.json"), dataDir: isPluginAdapter(selected) ? engineDir(directory, selected) : "" });
      ensureOutsrcHome(directory);
      if (first) createdThreadDirectory = directory;
      const lock = join(directory, "launch.lock");
      if (existsSync(lock)) {
        const owner = Number(readFileSync(lock, "utf8"));
        if (!pidAlive(owner)) rmSync(lock, { force: true });
      }
      writeHomeFile(lock, String(process.pid), { flag: "wx" });
      lockedThread = lock;
      if (!first && resultFor(loadThread(thread.id)) === null) throw new Error("thread is still working");
      if (requestFile) {
        try { writeHomeFile(requestFile, JSON.stringify({ fingerprint: requestFingerprint, threadId: thread.id, runId, preparation: { ownerPid: process.pid, previousRunId: thread.latestRunId, thread: { ...thread, latestRunId: runId }, run } }), { flag: "wx" }); }
        catch (error) {
          if (!existsSync(requestFile)) throw error;
          return replayRequest(requestFile, requestFingerprint);
        }
      }
      if (first) {
        addWorktree({ repo: repo.path, worktree: thread.worktree, branch: thread.branch, ...(input.ref !== undefined ? { ref: input.ref.trim() } : {}) });
        if (thread.taskKind !== "task") hideAgentConfig(thread.worktree);
        thread.baseCommit = getBaseCommit(thread.worktree);
        spec.baseCommit = thread.baseCommit;
      }
      mkdirSync(runDir, { recursive: true, mode: 0o700 }); try { chmodSync(runDir, 0o700); } catch {}
      writeJson(join(runDir, "run.json"), run);
      writeJson(join(runDir, "spec.json"), spec);
      thread.latestRunId = runId;
      writeJson(join(directory, "thread.json"), thread);
      const recorded = await startWrapper({ ctx, specFile: join(runDir, "spec.json") });
      if (recorded && !existsSync(join(runDir, "process.json"))) writeJson(join(runDir, "process.json"), recorded);
      return { ok: true, delivered: true, thread_id: thread.id, run_id: runId };
    } catch (error) {
      const message = errorMessage(error);
      if (runDir && thread && existsSync(join(runDir, "run.json"))) {
        const savedRun = RunSchema.parse(readJson(join(runDir, "run.json")));
        writeJson(join(runDir, "result.json"), failedResult(message, savedRun.sessionId));
        return { ok: true, delivered: true, thread_id: thread.id, run_id: savedRun.id };
      }
      else if (requestFile && thread && existsSync(requestFile)) {
        const previous = RequestSchema.parse(readJson(requestFile));
        if (previous.threadId === thread.id) rmSync(requestFile, { force: true });
      }
      if (createdThreadDirectory && !existsSync(join(createdThreadDirectory, "thread.json"))) {
        rmSync(createdThreadDirectory, { recursive: true, force: true });
        try { rmdirSync(threadsDir(ctx.home)); } catch {}
      }
      return { ok: false, error: message };
    } finally { if (lockedThread) rmSync(lockedThread, { force: true }); }
  }
  function threads() {
    if (!existsSync(threadsDir(ctx.home))) return { threads: [] };
    return { threads: readdirSync(threadsDir(ctx.home)).flatMap((name) => {
      try {
        const thread = loadThread(name);
        const status = inbox(name);
        if (!status.ok) return [];
        return [{ thread_id: thread.id, repo: thread.repo, target: thread.target, kind: thread.taskKind,
          status: status.status, discarded: existsSync(join(threadDir(ctx.home, thread.id), "discarded")), created_at: thread.createdAt, run_id: thread.latestRunId,
          run_count: readdirSync(join(threadDir(ctx.home, thread.id), "runs")).length,
          message: status.status === "working" ? status.progress : status.message }];
      } catch { return []; }
    }).sort((a, b) => b.created_at.localeCompare(a.created_at)) };
  }
  function discard(threadId: string) {
    try {
      const thread = loadThread(threadId);
      const result = resultFor(thread);
      if (!result || result.kind === "needs_input") throw new Error("only finished threads can be discarded");
      const repo = ctx.config.repos.find((item) => item.alias === thread.repo);
      if (!repo) throw new Error(`unknown repo: ${thread.repo}`);
      const registered = execFileSync("git", ["worktree", "list", "--porcelain", "-z"], { cwd: repo.path, encoding: "utf8" }).split("\0").includes(`worktree ${filesystemPath(thread.worktree)}`);
      if (registered) execFileSync("git", ["worktree", "remove", "--force", thread.worktree], { cwd: repo.path, stdio: "pipe" });
      else if (existsSync(thread.worktree)) rmSync(thread.worktree, { recursive: true });
      const branch = execFileSync("git", ["branch", "--list", thread.branch], { cwd: repo.path, encoding: "utf8" });
      if (branch.trim()) execFileSync("git", ["branch", "-D", thread.branch], { cwd: repo.path, stdio: "pipe" });
      writeHomeFile(join(threadDir(ctx.home, thread.id), "discarded"), new Date().toISOString());
      return { ok: true, discarded: true, thread_id: thread.id };
    } catch (error) { return { ok: false, error: errorMessage(error) }; }
  }
  return {
    listRepos: () => ({ repos: ctx.config.repos.map(({ alias, path }) => ({ alias, path })) }),
    listTargets: () => ({ targets: Object.entries(ctx.config.targets).map(([name, target]) => ({
      name, adapter: adapter(target, name).adapter, available: commandExists(target.command),
      models: target.models ?? null, effort: target.effort ?? null,
      description: target.description ?? "", cost_note: target.costNote ?? "Not configured",
      resume: adapter(target, name).adapter !== "custom" || target.args.some((arg) => arg.includes("{session_id}")),
      ...pluginStatus(adapter(target, name)),
    })) }),
    send, inbox, threads, discard,
    usage() {
      try {
        const samples: UsageSample[] = [];
        for (const name of existsSync(threadsDir(ctx.home)) ? readdirSync(threadsDir(ctx.home)) : []) {
          if (!MINTED_THREAD_ID.test(name)) continue;
          let thread: ThreadRecord;
          try { thread = loadThread(name); }
          catch (error) {
            if (errorMessage(error) === `unknown thread_id: ${name}`) continue;
            throw error;
          }
          for (const { run, result } of savedRuns(thread)) {
            samples.push({ target: thread.target, created_at: run.createdAt, usage: result?.usage ?? emptyUsage() });
          }
        }
        return aggregateUsage(samples);
      } catch (error) { return { ok: false, error: errorMessage(error) }; }
    },
    history(threadId: string) {
      try {
        const thread = loadThread(threadId);
        return { ok: true, thread_id: thread.id, runs: savedRuns(thread).map(({ run, result }) => {
          return { ...usageFields(thread, result), run_id: run.id, request_id: run.requestId, created_at: run.createdAt, message: run.message,
            status: result ? (result.kind === "completed" ? "succeeded" : result.kind) : "working",
            session_id: result?.sessionId ?? run.sessionId, final_message: result?.message ?? null,
            findings: result?.findings ?? [], exit_code: result?.exitCode ?? null };
        }) };
      } catch (error) { return { ok: false, error: errorMessage(error) }; }
    },
    log(input: { thread_id: string; run_id?: string; offset?: number; limit?: number }) {
      try {
        if (input.run_id !== undefined) parseRunId(input.run_id);
        const thread = loadThread(input.thread_id);
        const dir = storedRunDir(thread.id, input.run_id ?? thread.latestRunId);
        return { ok: true, text: tail(dir, input.offset, input.limit) };
      } catch (error) { return { ok: false, error: errorMessage(error) }; }
    },
    diff(input: { thread_id: string; limit?: number }) {
      try {
        const thread = loadThread(input.thread_id);
        if (!thread.baseCommit) throw new Error("No starting commit was recorded because task setup did not finish");
        return { ok: true, ...collectWorkspaceDiff({ workspace: thread.worktree, baseCommit: thread.baseCommit, ...(input.limit !== undefined ? { maxBytes: input.limit } : {}) }) };
      } catch (error) { return { ok: false, error: errorMessage(error) }; }
    },
    stop(threadId: string) {
      try {
        const thread = loadThread(threadId);
        const { dir } = current(thread);
        if (readResult(dir)) return { ok: true, stopped: true };
        const file = join(dir, "process.json");
        const recorded = readProcess(file);
        if (existsSync(file) && (!recorded || !sameProcess(recorded))) {
          throw new Error("refusing to signal a process that does not match the recorded wrapper");
        }
        writeHomeFile(join(dir, "cancelled"), "1");
        const target = ctx.config.targets[thread.target];
        const selected = target ? adapter(target, thread.target).adapter : "custom";
        if (target && isPluginAdapter(selected)) {
          // The plugin knows the vendor CLI's pids, including children that left the wrapper's process group.
          const data = engineDir(threadDir(ctx.home, thread.id), selected);
          for (const call of [cancelInvocation(selected, target.command, thread.worktree, data, thread.id), teardownInvocation(selected, target.command, thread.worktree, data)]) {
            if (!call) continue;
            spawnSync(call.command, call.args, { cwd: thread.worktree, input: call.input ?? "", env: { ...jobEnv(), ...call.env }, stdio: ["pipe", "ignore", "ignore"], timeout: 15_000 });
          }
        }
        if (recorded) stopOwnedProcess(recorded);
        return { ok: true, stopped: true };
      } catch (error) { return { ok: false, error: errorMessage(error) }; }
    },
    prune() {
      const removed: string[] = [];
      for (const item of threads().threads) {
        const repo = ctx.config.repos.find((entry) => entry.alias === item.repo);
        if (!repo?.retentionDays || item.status === "working" || item.status === "needs_input") continue;
        const thread = loadThread(item.thread_id);
        const result = resultFor(thread);
        if (!result || Date.now() - Date.parse(result.finishedAt) < repo.retentionDays * 86400_000) continue;
        if (existsSync(join(threadDir(ctx.home, thread.id), "discarded"))) continue;
        if (discard(thread.id).ok) removed.push(thread.id);
      }
      return { removed };
    },
  };
}
export type Mailbox = ReturnType<typeof createMailbox>;
