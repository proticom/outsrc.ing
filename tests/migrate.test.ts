import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addWorktree } from "../src/git.ts";
import { createMailbox } from "../src/mailbox.ts";
import { migrateLegacy } from "../src/migrate.ts";
import { readJson, ResultSchema, ThreadSchema, writeJson } from "../src/state.ts";
import { getBaseCommit } from "../src/workspace.ts";
import { initGitRepo } from "./helpers.ts";
import type { Config } from "../src/types.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "outsrc-migrate-test-"));
  roots.push(home);
  const repo = join(home, "repo");
  initGitRepo(repo);
  const config: Config = { repos: [{ alias: "demo", path: repo }], targets: {} };
  const id = "0123456789abcdef";
  const directory = join(home, "threads", id);
  const workspace = join(home, "worktrees", "demo", id);
  const branch = `agent/outsrc-${id}`;
  const base = getBaseCommit(repo);
  addWorktree({ repo, worktree: workspace, branch });
  mkdirSync(directory, { recursive: true });
  const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  if (exited.status !== 0) throw new Error("fixture process failed");
  const record = {
    id, repo: "demo", target: "fake", model: "fixture-model", effort: "low",
    status: "working", worktree: workspace, branch, pid: exited.pid, pgid: exited.pid,
    createdAt: "2026-09-01T00:00:00.000Z",
  };
  const file = join(directory, "thread.json");
  writeFileSync(file, JSON.stringify(record));
  writeFileSync(join(directory, "prompt.md"), "Original task");
  writeFileSync(join(directory, "run.log"), "Saved original output\n");
  return { home, repo, config, id, directory, workspace, branch, base, record, file };
}

describe("legacy terminal-thread migration", () => {
  it("preserves completed artifacts and recovers the original base after agent commits", () => {
    const f = fixture();
    const original = readFileSync(f.file, "utf8");
    writeFileSync(join(f.workspace, "result.txt"), "agent result\n");
    execFileSync("git", ["add", "result.txt"], { cwd: f.workspace });
    execFileSync("git", ["commit", "-m", "Agent result"], { cwd: f.workspace });
    writeFileSync(join(f.directory, "exit_code"), "0");
    writeFileSync(join(f.directory, "summary.md"), "Original final answer\n");
    writeFileSync(join(f.directory, "diffstat"), " saved diffstat\n");
    expect(migrateLegacy(f)).toEqual({ migrated: [f.id], skipped: [] });
    expect(readFileSync(join(f.directory, "thread.legacy.json"), "utf8")).toBe(original);
    const thread = ThreadSchema.parse(readJson(f.file));
    expect(thread).toMatchObject({ version: 2, baseCommit: f.base, latestRunId: "legacy", model: "fixture-model", effort: "low" });
    const box = createMailbox(f);
    expect(box.inbox(f.id)).toMatchObject({ status: "succeeded", message: "Original final answer", exit_code: 0, session_id: null, diffstat: { raw: " saved diffstat\n" } });
    expect(box.log({ thread_id: f.id })).toEqual({ ok: true, text: "Saved original output\n" });
    expect(box.diff({ thread_id: f.id })).toMatchObject({ ok: true, patch: expect.stringContaining("+agent result") });
    const saved = readFileSync(f.file, "utf8");
    expect(migrateLegacy(f)).toEqual({ migrated: [], skipped: [] });
    expect(readFileSync(f.file, "utf8")).toBe(saved);
  });

  it("preserves failure codes and cancellation while leaving session IDs unknown", async () => {
    const failed = fixture();
    writeFileSync(join(failed.directory, "exit_code"), "2");
    expect(migrateLegacy(failed)).toEqual({ migrated: [failed.id], skipped: [] });
    expect(createMailbox(failed).inbox(failed.id)).toMatchObject({ status: "failed", exit_code: 2, message: "Saved original output", session_id: null });
    expect(await createMailbox(failed).send({ thread_id: failed.id, message: "Continue" })).toMatchObject({ ok: false, error: expect.stringContaining("no resumable session") });
    const cancelled = fixture();
    writeFileSync(join(cancelled.directory, "cancelled"), "1");
    writeFileSync(join(cancelled.directory, "question.json"), JSON.stringify({ id: "old-question", text: "Question" }));
    expect(migrateLegacy(cancelled)).toEqual({ migrated: [cancelled.id], skipped: [] });
    expect(createMailbox(cancelled).inbox(cancelled.id)).toMatchObject({ status: "cancelled", exit_code: null, session_id: null });
  });

  it("imports a dead unfinished job as failed using its existing output", () => {
    const f = fixture();
    expect(migrateLegacy(f)).toEqual({ migrated: [f.id], skipped: [] });
    expect(createMailbox(f).inbox(f.id)).toMatchObject({ status: "failed", exit_code: null, message: "Saved original output" });
  });

  it("leaves active and unanswered legacy jobs unchanged", () => {
    const active = fixture();
    writeJson(active.file, { ...active.record, pid: process.pid });
    const before = readFileSync(active.file, "utf8");
    expect(migrateLegacy(active)).toEqual({ migrated: [], skipped: [{ thread_id: active.id, reason: "legacy job is still active; finish it before migrating" }] });
    expect(readFileSync(active.file, "utf8")).toBe(before);
    expect(existsSync(join(active.directory, "thread.legacy.json"))).toBe(false);
    const waiting = fixture();
    writeFileSync(join(waiting.directory, "question.json"), JSON.stringify({ id: "question-one", text: "Which color?" }));
    expect(migrateLegacy(waiting)).toEqual({ migrated: [], skipped: [{ thread_id: waiting.id, reason: "legacy job is waiting for input; finish it with the previous harness before migrating" }] });
    expect(existsSync(join(waiting.directory, "runs"))).toBe(false);
  });

  it("skips a missing branch reflog instead of guessing the starting commit", () => {
    const f = fixture();
    execFileSync("git", ["reflog", "expire", "--expire=all", `refs/heads/${f.branch}`], { cwd: f.repo });
    writeFileSync(join(f.directory, "exit_code"), "0");
    const before = readFileSync(f.file, "utf8");
    expect(migrateLegacy(f)).toEqual({ migrated: [], skipped: [{ thread_id: f.id, reason: "starting commit is unavailable in the branch reflog; no base was guessed" }] });
    expect(readFileSync(f.file, "utf8")).toBe(before);
  });

  it("reruns a partial migration without replacing the preserved original record", () => {
    const f = fixture();
    writeFileSync(join(f.directory, "exit_code"), "0");
    const backup = join(f.directory, "thread.legacy.json");
    copyFileSync(f.file, backup);
    const original = readFileSync(backup, "utf8");
    mkdirSync(join(f.directory, "runs", "legacy"), { recursive: true });
    writeFileSync(join(f.directory, "runs", "legacy", "result.json"), "partial data");
    expect(migrateLegacy(f)).toEqual({ migrated: [f.id], skipped: [] });
    expect(readFileSync(backup, "utf8")).toBe(original);
    expect(ResultSchema.parse(readJson(join(f.directory, "runs", "legacy", "result.json")))).toMatchObject({ kind: "completed", exitCode: 0, message: "Saved original output" });
  });

  it("skips retained later reflog entries when the initial branch entry has expired", () => {
    const f = fixture();
    writeFileSync(join(f.workspace, "result.txt"), "agent result\n");
    execFileSync("git", ["add", "result.txt"], { cwd: f.workspace });
    execFileSync("git", ["commit", "-m", "Agent result"], { cwd: f.workspace });
    execFileSync("git", ["reflog", "delete", `refs/heads/${f.branch}@{1}`], { cwd: f.repo });
    writeFileSync(join(f.directory, "exit_code"), "0");
    expect(migrateLegacy(f)).toEqual({ migrated: [], skipped: [{ thread_id: f.id, reason: "starting commit is unavailable in the branch reflog; no base was guessed" }] });
    expect(existsSync(join(f.directory, "runs"))).toBe(false);
  });
});
