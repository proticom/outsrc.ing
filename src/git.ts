import { execFileSync } from "node:child_process";
import { accessSync, constants, lstatSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { filesystemPath } from "./paths.js";

export const WorktreeCommandSchema = z.enum(["git", "git-cow"]);
export const WorktreeMethodSchema = z.union([WorktreeCommandSchema, z.templateLiteral(["git (fallback: ", z.string(), ")"])]);
export type WorktreeCommand = z.infer<typeof WorktreeCommandSchema>;
export type WorktreeMethod = z.infer<typeof WorktreeMethodSchema>;

export function addWorktree(opts: {
  repo: string;
  worktree: string;
  branch: string;
  ref?: string;
  command?: WorktreeCommand;
}): WorktreeMethod {
  mkdirSync(dirname(opts.worktree), { recursive: true });
  let method: WorktreeMethod = "git";
  if (opts.command === "git-cow") {
    const available = (process.env.PATH ?? "").split(delimiter).some((directory) => {
      const executable = resolve(opts.repo, directory, "git-cow");
      try { accessSync(executable, constants.X_OK); return statSync(executable).isFile(); }
      catch { return false; }
    });
    if (!available) method = "git (fallback: git-cow not found on PATH)";
    else {
      const registered = () => execFileSync("git", ["worktree", "list", "--porcelain", "-z"], { cwd: opts.repo, encoding: "utf8" })
        .split("\0").includes(`worktree ${filesystemPath(opts.worktree)}`);
      const branchExists = () => execFileSync("git", ["for-each-ref", "--format=%(refname)", `refs/heads/${opts.branch}`], { cwd: opts.repo, encoding: "utf8" })
        .trim().split("\n").includes(`refs/heads/${opts.branch}`);
      const destination = lstatSync(opts.worktree, { throwIfNoEntry: false });
      const existingFiles = destination !== undefined && (!destination.isDirectory() || readdirSync(opts.worktree).length > 0);
      const existingWorktree = registered();
      const existingBranch = branchExists();
      try {
        execFileSync("git", ["cow", "add", "-b", opts.branch, opts.worktree, opts.ref ?? "HEAD"], { cwd: opts.repo, stdio: "pipe" });
        return "git-cow";
      } catch (error) {
        if (!existingWorktree && !existingFiles) {
          if (registered()) {
            try { execFileSync("git", ["worktree", "remove", "--force", opts.worktree], { cwd: opts.repo, stdio: "pipe" }); }
            catch { rmSync(opts.worktree, { recursive: true, force: true }); }
            execFileSync("git", ["worktree", "prune"], { cwd: opts.repo, stdio: "pipe" });
          }
          rmSync(opts.worktree, { recursive: true, force: true });
          if (destination) mkdirSync(opts.worktree);
        }
        if (!existingBranch && branchExists()) execFileSync("git", ["branch", "-D", opts.branch], { cwd: opts.repo, stdio: "pipe" });
        const reason = error !== null && typeof error === "object" && "status" in error && typeof error.status === "number"
          ? `git-cow exited ${error.status}` : "git-cow failed";
        method = `git (fallback: ${reason})`;
      }
    }
  }
  execFileSync(
    "git",
    ["worktree", "add", "-b", opts.branch, opts.worktree, opts.ref ?? "HEAD"],
    { cwd: opts.repo, stdio: "pipe" },
  );
  return method;
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
