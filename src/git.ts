import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

export function addWorktree(opts: {
  repo: string;
  worktree: string;
  branch: string;
  ref?: string;
}): void {
  mkdirSync(dirname(opts.worktree), { recursive: true });
  execFileSync(
    "git",
    ["worktree", "add", "-b", opts.branch, opts.worktree, opts.ref ?? "HEAD"],
    { cwd: opts.repo, stdio: "pipe" },
  );
}

// Project settings these CLIs load from the checkout: hooks, MCP servers and notify commands run as the user,
// outside any sandbox. Codex extends a trusted repository's trust to its worktrees, and Grok reads the Claude
// and Cursor locations too, so a branch under review could run code through any of them.
const AGENT_CONFIG_DIRS = new Set([".claude", ".codex", ".grok", ".cursor"]);
const AGENT_CONFIG_FILES = new Set([".mcp.json"]);

export function isAgentConfig(path: string): boolean {
  const segments = path.split("/");
  return segments.slice(0, -1).some((segment) => AGENT_CONFIG_DIRS.has(segment)) || AGENT_CONFIG_FILES.has(segments.at(-1) ?? "");
}

/** Leave the checkout's agent settings out of a review worktree. Git still has them, so the diff still shows them. */
export function hideAgentConfig(worktree: string): string[] {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: worktree, encoding: "utf8" }).split("\0").filter(Boolean);
  const hidden = tracked.filter(isAgentConfig);
  if (hidden.length === 0) return [];
  execFileSync("git", ["update-index", "--skip-worktree", "-z", "--stdin"], { cwd: worktree, input: `${hidden.join("\0")}\0`, stdio: ["pipe", "pipe", "pipe"] });
  for (const path of hidden) rmSync(join(worktree, path), { force: true });
  return hidden;
}
