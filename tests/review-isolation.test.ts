import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { isAgentConfig } from "../src/git.ts";
import { createMailbox } from "../src/mailbox.ts";
import type { TaskKind } from "../src/types.ts";
import { initGitRepo, tempHome, testCtx } from "./helpers.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

// A branch that tries to run code through each CLI's project settings.
function repoWithAgentConfig() {
  const home = tempHome();
  const repo = join(home, "repo");
  initGitRepo(repo);
  for (const dir of [".claude", ".codex", ".grok", ".cursor", "packages/app/.grok"]) mkdirSync(join(repo, dir), { recursive: true });
  const files = [".claude/settings.json", ".codex/config.toml", ".grok/config.toml", ".cursor/hooks.json", ".mcp.json", "packages/app/.grok/config.toml"];
  for (const file of files) writeFileSync(join(repo, file), "run-something\n");
  writeFileSync(join(repo, "AGENTS.md"), "instructions stay\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "agent settings");
  return { home, repo, files };
}

async function finished(kind: TaskKind, setup: string[][] = []) {
  const { home, repo, files } = repoWithAgentConfig();
  const ctx = testCtx(home, repo);
  const box = createMailbox({ ...ctx, config: { ...ctx.config, repos: [{ alias: "demo", path: repo, setup }] } });
  const sent = await box.send({ repo: "demo", target: "fake", message: "look", kind });
  if (!sent.ok) throw new Error(sent.error);
  await expect.poll(() => { const r = box.inbox(sent.thread_id); return r.ok ? r.status : r.error; }).toBe("succeeded");
  const worktree = join(home, "worktrees", "demo", sent.thread_id);
  return { worktree, files };
}

describe("review worktrees", () => {
  test("a review runs without the branch's agent settings on disk, while git still has them", async () => {
    const { worktree, files } = await finished("review");
    expect(files.filter((file) => existsSync(join(worktree, file)))).toEqual([]);
    expect(existsSync(join(worktree, "AGENTS.md"))).toBe(true);
    expect(git(worktree, "show", "HEAD:.claude/settings.json")).toBe("run-something\n");
    expect(git(worktree, "status", "--porcelain", "--", ...files)).toBe("");
  });

  test("a task keeps the repository's agent settings", async () => {
    const { worktree, files } = await finished("task");
    expect(files.filter((file) => existsSync(join(worktree, file)))).toEqual(files);
  });

  test("setup commands run for tasks but not for reviews", async () => {
    const setup = [[process.execPath, "-e", "require('fs').writeFileSync('setup-ran', '1')"]];
    expect(existsSync(join((await finished("task", setup)).worktree, "setup-ran"))).toBe(true);
    expect(existsSync(join((await finished("adversarial_review", setup)).worktree, "setup-ran"))).toBe(false);
  });

  test("agent settings are matched at any depth, and only those", () => {
    expect([".claude/settings.json", "a/b/.grok/config.toml", ".mcp.json", "tools/.mcp.json", ".cursor/hooks.json", ".codex/hooks.json"].map(isAgentConfig))
      .toEqual([true, true, true, true, true, true]);
    expect(["CLAUDE.md", "AGENTS.md", "src/claude.ts", ".claudeignore", "docs/.codexrc", "mcp.json"].map(isAgentConfig))
      .toEqual([false, false, false, false, false, false]);
  });
});
