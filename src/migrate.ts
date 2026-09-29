import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { pidAlive } from "./job.js";
import { threadsDir } from "./paths.js";
import { readJson, ResultSchema, RunSchema, ThreadSchema, writeJson } from "./state.js";
import { parseAlias, parseTargetName, parseThreadId, type Config } from "./types.js";

const LegacyThreadSchema = z.object({
  id: z.string().transform(parseThreadId),
  repo: z.string().transform(parseAlias),
  target: z.string().transform(parseTargetName),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  status: z.enum(["working", "needs_input", "succeeded", "failed", "cancelled"]),
  worktree: z.string(),
  branch: z.string(),
  pid: z.number(),
  pgid: z.number(),
  createdAt: z.string(),
});
const QuestionSchema = z.object({ id: z.string(), text: z.string() });

function readText(file: string): string {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function unansweredQuestion(directory: string): boolean {
  const questionFile = join(directory, "question.json");
  if (!existsSync(questionFile)) return false;
  const question = QuestionSchema.safeParse(readJson(questionFile));
  if (!question.success) return false;
  const answerFile = join(directory, "answer.json");
  if (!existsSync(answerFile)) return true;
  const answer = QuestionSchema.safeParse(readJson(answerFile));
  return !answer.success || answer.data.id !== question.data.id;
}

export function migrateLegacy(input: { home: string; config: Config }): {
  migrated: string[];
  skipped: { thread_id: string; reason: string }[];
} {
  const report: { migrated: string[]; skipped: { thread_id: string; reason: string }[] } = { migrated: [], skipped: [] };
  const root = threadsDir(input.home);
  if (!existsSync(root)) return report;
  for (const name of readdirSync(root)) {
    const directory = join(root, name);
    const file = join(directory, "thread.json");
    if (!existsSync(file)) continue;
    try {
      const value = readJson(file);
      if (ThreadSchema.safeParse(value).success) continue;
      const legacy = LegacyThreadSchema.parse(value);
      const exitFile = join(directory, "exit_code");
      const cancelledFile = join(directory, "cancelled");
      const hasExit = existsSync(exitFile);
      const cancelled = existsSync(cancelledFile);
      if (!hasExit && !cancelled) {
        if (legacy.status === "needs_input" || unansweredQuestion(directory)) throw new Error("legacy job is waiting for input; finish it with the previous harness before migrating");
        if (pidAlive(legacy.pid)) throw new Error("legacy job is still active; finish it before migrating");
      }
      const repo = input.config.repos.find((entry) => entry.alias === legacy.repo);
      if (!repo) throw new Error(`repository is no longer configured: ${legacy.repo}`);
      let baseCommit: string | undefined;
      try {
        const oldest = execFileSync("git", ["reflog", "show", "--format=%H%x00%gs", `refs/heads/${legacy.branch}`], {
          cwd: repo.path, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        }).trim().split("\n").filter(Boolean).at(-1);
        const [commit, event] = oldest?.split("\0") ?? [];
        if (event?.startsWith("branch: Created from ")) baseCommit = commit;
      } catch { baseCommit = undefined; }
      if (!baseCommit) throw new Error("starting commit is unavailable in the branch reflog; no base was guessed");
      const logFile = join(directory, "run.log");
      const summaryFile = existsSync(join(directory, "summary.md"))
        ? join(directory, "summary.md") : join(legacy.worktree, "SUMMARY.md");
      const exitCode = hasExit ? z.number().finite().parse(Number(readText(exitFile).trim())) : null;
      const message = readText(summaryFile).trim() || readText(logFile).trim().slice(-500) || `(no summary, exit ${exitCode})`;
      const finishedFile = cancelled ? cancelledFile : hasExit ? exitFile : existsSync(logFile) ? logFile : file;
      const runId = "legacy";
      const run = RunSchema.parse({
        id: runId, threadId: legacy.id, requestId: null,
        message: readText(join(directory, "prompt.md")).trim(),
        createdAt: legacy.createdAt, sessionId: null,
      });
      const result = ResultSchema.parse({
        kind: cancelled ? "cancelled" : exitCode === 0 ? "completed" : "failed",
        message, sessionId: null, findings: [], exitCode,
        finishedAt: statSync(finishedFile).mtime.toISOString(),
        diffstat: readText(join(directory, "diffstat")), commit: null,
      });
      const thread = ThreadSchema.parse({
        version: 2, id: legacy.id, repo: legacy.repo, target: legacy.target,
        model: legacy.model, effort: legacy.effort, taskKind: "task",
        worktree: legacy.worktree, branch: legacy.branch, baseCommit,
        createdAt: legacy.createdAt, latestRunId: runId,
      });
      const backup = join(directory, "thread.legacy.json");
      if (!existsSync(backup)) copyFileSync(file, backup);
      const runDir = join(directory, "runs", runId);
      mkdirSync(runDir, { recursive: true });
      if (existsSync(logFile)) copyFileSync(logFile, join(runDir, "run.log"));
      writeJson(join(runDir, "run.json"), run);
      writeJson(join(runDir, "result.json"), result);
      writeJson(file, thread);
      report.migrated.push(legacy.id);
    } catch (error) {
      report.skipped.push({ thread_id: name, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return report;
}
