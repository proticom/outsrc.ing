const { execFileSync } = require("node:child_process");
const { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { basename, dirname, join } = require("node:path");

const args = process.argv.slice(2);
appendFileSync(join(__dirname, "calls.jsonl"), `${JSON.stringify(args)}\n`);
const mode = readFileSync(join(__dirname, "mode"), "utf8");
const [, , branch, worktree, ref] = args;
const repo = basename(process.cwd());
const helper = join(dirname(worktree), ".git-cow", repo);
const git = (...argv) => execFileSync("git", argv, { stdio: "pipe" });
if (!existsSync(helper)) {
  mkdirSync(dirname(helper), { recursive: true });
  git("worktree", "add", "--detach", helper, "HEAD");
  writeFileSync(join(dirname(helper), `.${repo}.lock`), "locked\n");
  writeFileSync(join(dirname(helper), `.${repo}.warmed`), "warmed\n");
}
if (mode === "folder" || mode === "branch") {
  git("branch", branch, ref);
  if (mode === "folder") {
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, "partial"), "unfinished clone\n");
  }
} else {
  git("worktree", ...args);
  if (mode === "broken") rmSync(join(worktree, ".git"));
}
process.exit(mode === "success" ? 0 : 7);
