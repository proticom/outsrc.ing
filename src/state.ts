import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { writeHomeFile } from "./fs-home.js";
import { join } from "node:path";
import { z } from "zod";
import { FindingSchema } from "./adapters.js";
import { parseAlias, parseRunId, parseTargetName, parseThreadId, STORAGE_ID } from "./types.js";

export const ThreadSchema = z.object({
  version: z.literal(2),
  id: z.string().transform(parseThreadId),
  caller: z.string().default("local"),
  repo: z.string().transform(parseAlias),
  target: z.string().transform(parseTargetName),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  taskKind: z.enum(["task", "review", "adversarial_review"]),
  base: z.string().nullable().default(null),
  worktree: z.string(),
  branch: z.string(),
  baseCommit: z.string(),
  createdAt: z.string(),
  latestRunId: z.string().refine((value) => value === "" || STORAGE_ID.test(value), "latest run id is not a storage id"),
});
export const RunSchema = z.object({
  id: z.string().transform(parseRunId),
  threadId: z.string().transform(parseThreadId),
  requestId: z.string().nullable(),
  message: z.string(),
  createdAt: z.string(),
  sessionId: z.string().nullable(),
});
export const ResultSchema = z.object({
  kind: z.enum(["completed", "needs_input", "failed", "cancelled"]),
  message: z.string(),
  sessionId: z.string().nullable(),
  findings: z.array(FindingSchema),
  exitCode: z.number().nullable(),
  finishedAt: z.string(),
  diffstat: z.string(),
  commit: z.string().nullable(),
});
export const ProcessSchema = z.object({
  pid: z.number().int().gte(2),
  pgid: z.number().int().gte(2),
  startedAt: z.string().min(1),
}).refine((value) => value.pid === value.pgid, "process group must be the wrapper process");
export function writeJson(file: string, value: unknown): void {
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  writeHomeFile(temporary, JSON.stringify(value, null, 2));
  renameSync(temporary, file);
}
export function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}
export function runDirectory(threadDirectory: string, runId: string): string {
  return join(threadDirectory, "runs", runId);
}
export function readResult(directory: string) {
  const file = join(directory, "result.json");
  return existsSync(file) ? ResultSchema.parse(readJson(file)) : null;
}
