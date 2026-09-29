import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DEFAULT_DIFF_BYTES = 256 * 1024;

export type WorkspaceDiff = {
  patch: string;
  stat: string;
  truncated: boolean;
};

function git(args: string[], workspace: string, env = process.env): string {
  return execFileSync("git", args, {
    cwd: workspace,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function getBaseCommit(repo: string): string {
  return git(["rev-parse", "HEAD"], repo);
}

function boundedGit(
  args: string[],
  workspace: string,
  env: NodeJS.ProcessEnv,
  limit: number,
): { text: string; truncated: boolean } {
  const result = spawnSync("git", args, {
    cwd: workspace,
    env,
    maxBuffer: limit + 1,
  });
  let truncated = result.stdout.length > limit || result.error?.message.includes("ENOBUFS") === true;
  if (!truncated && (result.error || result.status !== 0)) {
    throw result.error ?? new Error(result.stderr.toString().trim() || "git diff failed");
  }
  const text = result.stdout.subarray(0, limit).toString("utf8");
  const encoded = Buffer.from(text);
  truncated ||= encoded.length > limit;
  return {
    text: new TextDecoder().decode(encoded.subarray(0, limit), { stream: true }),
    truncated,
  };
}

export function collectWorkspaceDiff(input: {
  workspace: string;
  baseCommit: string;
  maxBytes?: number;
}): WorkspaceDiff {
  const maxBytes = input.maxBytes ?? DEFAULT_DIFF_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("maxBytes must be a positive integer");
  }
  const temporary = mkdtempSync(join(tmpdir(), "outsrc-diff-"));
  try {
    const index = join(temporary, "index");
    const currentIndex = resolve(input.workspace, git(["rev-parse", "--git-path", "index"], input.workspace));
    const env = { ...process.env, GIT_INDEX_FILE: index };
    if (existsSync(currentIndex)) copyFileSync(currentIndex, index);
    else git(["read-tree", "HEAD"], input.workspace, env);
    git(["add", "-A", "--", "."], input.workspace, env);
    const args = ["diff", "--cached", "--no-color"];
    const patch = boundedGit([...args, input.baseCommit, "--"], input.workspace, env, maxBytes);
    const stat = boundedGit([...args, "--stat", input.baseCommit, "--"], input.workspace, env, maxBytes);
    return { patch: patch.text, stat: stat.text, truncated: patch.truncated || stat.truncated };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function commitWorkspace(input: {
  workspace: string;
  message: string;
}): { commit: string; changed: boolean } {
  git(["add", "-A", "--", "."], input.workspace);
  const tree = git(["write-tree"], input.workspace);
  const changed = tree !== git(["rev-parse", "HEAD^{tree}"], input.workspace);
  if (changed) git(["commit", "-m", input.message], input.workspace);
  return { commit: getBaseCommit(input.workspace), changed };
}
