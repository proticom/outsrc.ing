const { execFileSync, spawn } = require("node:child_process");
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
  if (mode === "broken") {
    const admin = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: worktree, encoding: "utf8" }).trim();
    writeFileSync(join(admin, "failed-attempt"), "unfinished clone\n");
    rmSync(join(worktree, ".git"));
  }
}
if (mode === "stderr") {
  process.stderr.write(` \nclone\tfailed:\n ${"x".repeat(300)}\n`);
  process.stdout.write("ignored stdout\n");
}
if (mode === "stdout") {
  process.stderr.write(" \n\t ");
  process.stdout.write(" \nstdout\tclone\nfailure \n");
}
if (mode === "timeout" || mode === "timeout-orphan") {
  const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000);'], { stdio: ["ignore", "pipe", "ignore"] });
  child.stdout.once("data", () => {
    writeFileSync(join(__dirname, "child.pid"), String(child.pid));
    writeFileSync(join(__dirname, "stub.pid"), String(process.pid));
  });
  process.on("SIGTERM", () => {
    writeFileSync(join(__dirname, "terminated"), "SIGTERM\n");
    if (mode === "timeout-orphan") process.exit(0);
  });
  setInterval(() => {}, 1000);
} else if (mode === "waiting") {
  writeFileSync(join(__dirname, "ready"), "ready\n");
  setInterval(() => { if (existsSync(join(__dirname, "release"))) process.exit(0); }, 20);
} else process.exit(mode === "success" ? 0 : 7);
