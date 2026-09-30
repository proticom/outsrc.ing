import type { Limits } from "./limits.js";
import type { AdapterTarget, Finding } from "./adapters.js";
import type { RunUsage } from "./usage.js";

export type ThreadId = string & { readonly __brand: "ThreadId" };
export type RunId = string & { readonly __brand: "RunId" };
export type Alias = string & { readonly __brand: "Alias" };
export type TargetName = string & { readonly __brand: "TargetName" };

export const MINTED_THREAD_ID = /^[0-9a-f]{16}$/;
export const STORAGE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// Who is connected: each registration of the server names its caller, and a caller sees only its own threads.
export const CALLER = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const DEFAULT_CALLER = "local";
export function parseCaller(raw: string): string {
  const caller = raw.trim();
  if (!CALLER.test(caller)) throw new Error("caller must match ^[a-z0-9][a-z0-9-]{0,31}$");
  return caller;
}

export function parseThreadId(raw: string): ThreadId {
  const id = raw.trim();
  if (!MINTED_THREAD_ID.test(id)) throw new Error("thread_id must be 16 lowercase hex characters");
  return id as ThreadId;
}
export function parseRunId(raw: string): RunId {
  const id = raw.trim();
  if (!STORAGE_ID.test(id)) throw new Error("run_id must be a single storage id");
  return id as RunId;
}
export function parseAlias(raw: string): Alias {
  const alias = raw.trim();
  if (!alias) throw new Error("repo is required");
  return alias as Alias;
}
export function parseTargetName(raw: string): TargetName {
  const target = raw.trim();
  if (!target) throw new Error("target is required");
  return target as TargetName;
}

export type PermissionMode = "auto" | "ask";
export type TaskKind = "task" | "review" | "adversarial_review";
export type RepoConfig = {
  alias: string;
  path: string;
  setup?: string[][];
  autoCommit?: boolean;
  retentionDays?: number;
};
export type TargetConfig = {
  adapter?: AdapterTarget["adapter"];
  command: string;
  args: string[];
  permissions?: PermissionMode;
  models?: { default: string; allowed: string[] };
  effort?: { default: string; allowed: string[] };
  description?: string;
  costNote?: string;
};
export type Config = { repos: RepoConfig[]; targets: Record<string, TargetConfig>; limits?: Limits };

export type ThreadRecord = {
  version: 2;
  id: ThreadId;
  caller: string;
  repo: Alias;
  target: TargetName;
  model: string | null;
  effort: string | null;
  taskKind: TaskKind;
  base: string | null;
  worktree: string;
  branch: string;
  baseCommit: string;
  createdAt: string;
  latestRunId: string;
};
export type RunRecord = {
  id: string;
  threadId: ThreadId;
  requestId: string | null;
  message: string;
  createdAt: string;
  sessionId: string | null;
};
export type RunSpec = {
  threadId: ThreadId;
  runId: string;
  runDir: string;
  worktree: string;
  baseCommit: string;
  target: AdapterTarget;
  model: string | null;
  effort: string | null;
  permissions: PermissionMode;
  sessionId: string | null;
  prompt: string;
  setup: string[][];
  autoCommit: boolean;
  kind: TaskKind;
  base: string | null;
  // null runs without a deadline; absent means the spec predates configurable limits.
  deadlineMs?: number | null;
};
export type RunResult = {
  usage: RunUsage;
  kind: "completed" | "needs_input" | "failed" | "cancelled";
  message: string;
  sessionId: string | null;
  findings: Finding[];
  exitCode: number | null;
  finishedAt: string;
  diffstat: string;
  commit: string | null;
};
export type SendInput = {
  message: string;
  repo?: string;
  target?: string;
  thread_id?: string;
  request_id?: string;
  model?: string;
  effort?: string;
  kind?: TaskKind;
  base?: string;
  ref?: string;
};
export type SendResult =
  | { ok: true; delivered: true; thread_id: ThreadId; run_id: string }
  | { ok: false; error: string };
export type ThreadStatus = "working" | "needs_input" | "succeeded" | "failed" | "cancelled";
export type UsageFields = {
  target: string;
  effort: string | null;
  model: string | null;
  usage: Omit<RunUsage, "model" | "effort">;
};
export type InboxResult = (
  | { ok: true; status: "working"; retry_after_seconds: number; run_id: string; progress: string }
  | { ok: true; status: "needs_input"; retry_after_seconds: number; run_id: string; message: string; question_id: string; session_id: string | null }
  | { ok: true; status: "succeeded" | "failed" | "cancelled"; run_id: string; message: string; branch: string; worktree: string; diffstat: { raw: string }; exit_code: number | null; session_id: string | null; findings: Finding[]; commit: string | null }
) & UsageFields | { ok: false; error: string };
export type LogResult = { ok: true; text: string } | { ok: false; error: string };
export type StopResult = { ok: true; stopped: true } | { ok: false; error: string };
export type MailboxContext = {
  home: string;
  // The connected caller. Undefined only for the owner's own CLI (outsrc threads, prune), which sees every thread.
  caller?: string;
  config: Config;
  retryAfterSeconds?: number;
  wrapperCommand?: string[];
  nodeExecutable?: string;
};
