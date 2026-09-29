import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addWorktree } from "../src/git.ts";
import { collectWorkspaceDiff, commitWorkspace, getBaseCommit } from "../src/workspace.ts";
import { initGitRepo } from "./helpers.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(workspace: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: workspace, encoding: "utf8" }).trim();
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "outsrc-workspace-test-"));
  roots.push(home);
  const repo = join(home, "source");
  const workspace = join(home, "worktree");
  initGitRepo(repo);
  const baseCommit = getBaseCommit(repo);
  addWorktree({ repo, worktree: workspace, branch: "agent/artifact-test" });
  return { workspace, baseCommit };
}

describe("worktree artifacts", () => {
  it("returns an empty diff for an unchanged worktree", () => {
    const f = fixture();
    expect(getBaseCommit(f.workspace)).toBe(f.baseCommit);
    expect(collectWorkspaceDiff(f)).toEqual({ patch: "", stat: "", truncated: false });
  });

  it("reports committed, staged, unstaged and untracked changes without altering the index", () => {
    const f = fixture();
    writeFileSync(join(f.workspace, "README.md"), "committed\n");
    git(f.workspace, "add", "README.md");
    git(f.workspace, "commit", "-m", "agent commit");
    expect(collectWorkspaceDiff(f).patch).toContain("-fixture\n+committed");
    writeFileSync(join(f.workspace, "staged.txt"), "staged\n");
    git(f.workspace, "add", "staged.txt");
    writeFileSync(join(f.workspace, "README.md"), "unstaged\n");
    writeFileSync(join(f.workspace, "new.txt"), "untracked\n");
    const indexPath = resolve(f.workspace, git(f.workspace, "rev-parse", "--git-path", "index"));
    const index = readFileSync(indexPath);
    const first = collectWorkspaceDiff(f);
    expect(first.patch).toContain("-fixture\n+unstaged");
    expect(first.patch).toContain("+staged");
    expect(first.patch).toContain("+untracked");
    expect(first.stat).toContain("3 files changed, 3 insertions(+), 1 deletion(-)");
    expect(first.truncated).toBe(false);
    expect(readFileSync(indexPath)).toEqual(index);
    expect(collectWorkspaceDiff(f)).toEqual(first);
  });

  it("retains committed and staged additions that later become ignored", () => {
    const f = fixture();
    writeFileSync(join(f.workspace, "committed.log"), "committed addition\n");
    git(f.workspace, "add", "committed.log");
    git(f.workspace, "commit", "-m", "Track log");
    writeFileSync(join(f.workspace, "staged.log"), "staged addition\n");
    git(f.workspace, "add", "staged.log");
    writeFileSync(join(f.workspace, ".gitignore"), "*.log\n");
    const diff = collectWorkspaceDiff(f);
    expect(diff.patch).toContain("+committed addition");
    expect(diff.patch).toContain("+staged addition");
  });

  it("reports truncation and returns the requested prefix for larger artifacts", () => {
    const f = fixture();
    writeFileSync(join(f.workspace, "large.txt"), "long line\n".repeat(10_000));
    const full = collectWorkspaceDiff(f);
    const short = collectWorkspaceDiff({ ...f, maxBytes: 512 });
    expect(Buffer.byteLength(short.patch)).toBe(512);
    expect(short.patch).toBe(full.patch.slice(0, 512));
    expect(short.truncated).toBe(true);
    expect(full.truncated).toBe(false);
  });

  it("makes an optional commit and does not create empty commits on retries", () => {
    const f = fixture();
    expect(commitWorkspace({ workspace: f.workspace, message: "No changes" })).toEqual({ commit: f.baseCommit, changed: false });
    writeFileSync(join(f.workspace, "result.txt"), "result\n");
    const result = commitWorkspace({ workspace: f.workspace, message: "Complete task" });
    expect(result.changed).toBe(true);
    expect(git(f.workspace, "show", "HEAD:result.txt")).toBe("result");
    expect(git(f.workspace, "status", "--porcelain")).toBe("");
    expect(git(f.workspace, "log", "-1", "--format=%s")).toBe("Complete task");
    expect(commitWorkspace({ workspace: f.workspace, message: "Complete task" })).toEqual({ commit: result.commit, changed: false });
    expect(collectWorkspaceDiff(f).patch).toContain("+result");
  });
});
