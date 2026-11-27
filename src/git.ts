import { execFileSync, spawn } from "node:child_process";
import { accessSync, constants, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { filesystemPath } from "./paths.js";

export const WorktreeCommandSchema = z.enum(["git", "git-cow"]);
export const WorktreeMethodSchema = z.union([WorktreeCommandSchema, z.templateLiteral(["git (fallback: ", z.string(), ")"])]);
export type WorktreeCommand = z.infer<typeof WorktreeCommandSchema>;
export type WorktreeMethod = z.infer<typeof WorktreeMethodSchema>;

function commandDiagnostic(output: unknown): string {
  const text = Buffer.isBuffer(output) ? output.toString("utf8") : typeof output === "string" ? output : "";
  return text.trim().replace(/\s+/g, " ").slice(0, 200).trimEnd();
}

function gitCowFailureReason(error: unknown): string {
  if (error === null || typeof error !== "object") return "git-cow failed";
  if ("code" in error && error.code === "ETIMEDOUT") return "git-cow timed out";
  const status = "status" in error && typeof error.status === "number" ? `git-cow exited ${error.status}` : "git-cow failed";
  const diagnostic = ("stderr" in error ? commandDiagnostic(error.stderr) : "")
    || ("stdout" in error ? commandDiagnostic(error.stdout) : "");
  return diagnostic ? `${status}: ${diagnostic}` : status;
}

type GitCowResult = { kind: "created" } | { kind: "failed"; reason: string };

async function runGitCow(opts: { repo: string; args: string[]; timeoutMs: number }): Promise<GitCowResult> {
  if (process.platform === "win32") {
    try {
      execFileSync("git", opts.args, { cwd: opts.repo, stdio: "pipe", timeout: opts.timeoutMs });
      return { kind: "created" };
    } catch (error) { return { kind: "failed", reason: gitCowFailureReason(error) }; }
  }
  let child;
  try { child = spawn("git", opts.args, { cwd: opts.repo, detached: true, stdio: ["ignore", "pipe", "pipe"] }); }
  catch (error) { return { kind: "failed", reason: gitCowFailureReason(error) }; }
  const pid = child.pid;
  const signalGroup = (signal: NodeJS.Signals) => {
    if (pid === undefined) return;
    try { process.kill(-pid, signal); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  };
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout = (stdout + chunk).replace(/\s+/g, " ").trimStart().slice(0, 201); });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).replace(/\s+/g, " ").trimStart().slice(0, 201); });
  return new Promise((resolve, reject) => {
    let result: GitCowResult | undefined;
    let phase: "running" | "terminating" | "terminated" = "running";
    const finish = () => {
      if (!result || phase === "terminating") return;
      clearTimeout(timer);
      resolve(phase === "terminated" ? { kind: "failed", reason: "git-cow timed out" } : result);
    };
    const timer = setTimeout(() => {
      phase = "terminating";
      try { signalGroup("SIGTERM"); }
      catch (error) { reject(error); return; }
      setTimeout(() => {
        try {
          signalGroup("SIGKILL");
          phase = "terminated";
          finish();
        } catch (error) { reject(error); }
      }, 2000);
    }, opts.timeoutMs);
    child.once("error", (error) => {
      result = { kind: "failed", reason: gitCowFailureReason(error) };
      finish();
    });
    child.once("close", (status) => {
      result = status === 0 ? { kind: "created" } : { kind: "failed", reason: gitCowFailureReason({ status, stdout, stderr }) };
      finish();
    });
  });
}

function removeWorktreeRegistration(opts: { repo: string; worktree: string }): void {
  const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: opts.repo, encoding: "utf8" }).trim();
  const registrations = resolve(opts.repo, commonDir, "worktrees");
  const target = filesystemPath(join(opts.worktree, ".git"));
  for (const entry of readdirSync(registrations, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const admin = join(registrations, entry.name);
    let gitdir: string;
    try { gitdir = readFileSync(join(admin, "gitdir"), "utf8").trim(); }
    catch { continue; }
    if (gitdir && filesystemPath(resolve(admin, gitdir)) === target) {
      rmSync(admin, { recursive: true, force: true });
      return;
    }
  }
}

export async function addWorktree(opts: {
  repo: string;
  worktree: string;
  branch: string;
  ref?: string;
  command?: WorktreeCommand;
}): Promise<WorktreeMethod> {
  mkdirSync(dirname(opts.worktree), { recursive: true });
  let method: WorktreeMethod = "git";
  if (opts.command === "git-cow") {
    const timeoutMs = z.coerce.number().int().positive().max(2_147_483_647).default(600_000).parse(process.env.OUTSRC_GIT_COW_TIMEOUT_MS);
    const execPath = execFileSync("git", ["--exec-path"], { cwd: opts.repo, encoding: "utf8" }).trim();
    const available = [execPath, ...(process.env.PATH ?? "").split(delimiter)].some((directory) => {
      const executable = resolve(opts.repo, directory, "git-cow");
      try { accessSync(executable, constants.X_OK); return statSync(executable).isFile(); }
      catch { return false; }
    });
    if (!available) method = "git (fallback: git-cow not found in git exec-path or PATH)";
    else {
      const registered = () => execFileSync("git", ["worktree", "list", "--porcelain", "-z"], { cwd: opts.repo, encoding: "utf8" })
        .split("\0").includes(`worktree ${filesystemPath(opts.worktree)}`);
      const branchExists = () => execFileSync("git", ["for-each-ref", "--format=%(refname)", `refs/heads/${opts.branch}`], { cwd: opts.repo, encoding: "utf8" })
        .trim().split("\n").includes(`refs/heads/${opts.branch}`);
      const destination = lstatSync(opts.worktree, { throwIfNoEntry: false });
      const existingFiles = destination !== undefined && (!destination.isDirectory() || readdirSync(opts.worktree).length > 0);
      const existingWorktree = registered();
      const existingBranch = branchExists();
      const result = await runGitCow({ repo: opts.repo, args: ["cow", "add", "-b", opts.branch, opts.worktree, opts.ref ?? "HEAD"], timeoutMs });
      if (result.kind === "created") return "git-cow";
      if (!existingWorktree && !existingFiles) {
        if (registered()) {
          try { execFileSync("git", ["worktree", "remove", "--force", opts.worktree], { cwd: opts.repo, stdio: "pipe" }); }
          catch { removeWorktreeRegistration(opts); }
        }
        rmSync(opts.worktree, { recursive: true, force: true });
        if (destination) mkdirSync(opts.worktree);
      }
      if (!existingBranch && branchExists()) execFileSync("git", ["branch", "-D", opts.branch], { cwd: opts.repo, stdio: "pipe" });
      method = `git (fallback: ${result.reason})`;
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
