import { execFileSync, spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { addWorktree, hideAgentConfig, parseGitCowTimeout, WorktreeMethodSchema, type WorktreeCommand } from "../src/git.ts";
import { createMailbox, requestFileName } from "../src/mailbox.ts";
import { migrateLegacy } from "../src/migrate.ts";
import { readJson, ResultSchema, RunSchema, ThreadSchema, writeJson } from "../src/state.ts";
import { initGitRepo, tempHome, testCtx } from "./helpers.ts";

function executable(name: string, directories = (process.env.PATH ?? "").split(delimiter)): string | undefined {
  return directories.map((directory) => join(directory, name)).find((path) => {
    try { accessSync(path, constants.X_OK); return statSync(path).isFile(); }
    catch { return false; }
  });
}

const originalPath = process.env.PATH ?? "";
const originalExecPath = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
const realCow = executable("git-cow", [originalExecPath, ...originalPath.split(delimiter)]);
const realGit = executable("git");
const sessionTool = executable("perl") ?? executable("python3");
const sleep = executable("sleep");
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });

function fixture(mode = "success") {
  const home = realpathSync(tempHome());
  roots.push(home);
  const repo = join(home, "repo");
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_COW", "1");
  initGitRepo(repo);
  mkdirSync(join(repo, ".claude"));
  writeFileSync(join(repo, ".claude", "settings.json"), "{\"hooks\":{}}\n");
  writeFileSync(join(repo, "AGENTS.md"), "Keep instructions\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "Agent configuration");
  const worktree = join(home, "worktrees", "demo", "job with spaces;literal");
  const branch = "agent/job";
  const bin = join(home, "bin");
  mkdirSync(bin);
  const execPath = join(home, "git-exec");
  mkdirSync(execPath);
  for (const name of readdirSync(originalExecPath)) {
    if (name !== "git-cow") symlinkSync(join(originalExecPath, name), join(execPath, name));
  }
  vi.stubEnv("GIT_EXEC_PATH", execPath);
  if (!realGit) throw new Error("git is required");
  symlinkSync(realGit, join(bin, "git"));
  const ps = executable("ps");
  if (ps) symlinkSync(ps, join(bin, "ps"));
  if (mode !== "missing") {
    const shim = readFileSync(new URL("./fixtures/fake-git-cow.cjs", import.meta.url), "utf8");
    writeFileSync(join(bin, "git-cow"), `#!${process.execPath}\n${shim}`, { mode: mode === "not-executable" ? 0o600 : 0o700 });
    writeFileSync(join(bin, "mode"), mode);
  }
  vi.stubEnv("PATH", bin);
  vi.stubEnv("OUTSRC_HOME", home);
  const helper = join(dirname(worktree), ".git-cow", basename(repo));
  const calls = () => existsSync(join(bin, "calls.jsonl"))
    ? readFileSync(join(bin, "calls.jsonl"), "utf8").trim().split("\n").map((line): unknown => JSON.parse(line)) : [];
  return { home, repo, worktree, branch, helper, bin, execPath, calls };
}

function expectHelper(f: ReturnType<typeof fixture>) {
  expect(readFileSync(join(f.helper, "README.md"), "utf8")).toBe("fixture\n");
  expect(readFileSync(join(dirname(f.helper), ".repo.lock"), "utf8")).toBe("locked\n");
  expect(readFileSync(join(dirname(f.helper), ".repo.warmed"), "utf8")).toBe("warmed\n");
  expect(git(f.repo, "worktree", "list", "--porcelain", "-z").split("\0")).toContain(`worktree ${f.helper}`);
}

function expectWorktree(f: ReturnType<typeof fixture>) {
  expect(git(f.worktree, "branch", "--show-current").trim()).toBe(f.branch);
  expect(readFileSync(join(f.worktree, "README.md"), "utf8")).toBe("fixture\n");
  const registrations = git(f.repo, "worktree", "list", "--porcelain", "-z").split("\0").filter((entry) => entry.startsWith("worktree "));
  expect(registrations.sort()).toEqual([f.repo, f.helper, f.worktree].map((path) => `worktree ${path}`).sort());
}

describe("worktree commands", () => {
  test.skipIf(process.platform === "win32").each(["SIGTERM", "SIGINT", "SIGHUP", "exit", "listener", "handled", "late", "late-prepended", "removed", "denied-exit", "concurrent"])("sender shutdown %s removes only its attempts and preserves exit semantics", async (mode) => {
    const f = fixture("timeout");
    mkdirSync(dirname(f.helper), { recursive: true });
    git(f.repo, "worktree", "add", "--detach", f.helper);
    writeFileSync(join(dirname(f.helper), ".repo.lock"), "locked\n");
    writeFileSync(join(dirname(f.helper), ".repo.warmed"), "warmed\n");
    const attempts = Array.from({ length: mode === "concurrent" ? 2 : 1 }, (_, index) => ({
      repo: f.repo, worktree: `${f.worktree}-${index}`, branch: `agent/outsrc-0123456789abcde${index}`, command: "git-cow",
    }));
    const outcomes = join(f.home, "outcomes");
    const handled = join(f.home, "handled");
    const script = `
      import { appendFileSync } from 'node:fs';
      import { addWorktree } from ${JSON.stringify(new URL("../src/git.ts", import.meta.url).href)};
      const [attempts, mode, outcomes, handled] = JSON.parse(process.argv[1]);
      const listener = () => {
        appendFileSync(handled, 'handled once\\n');
        if (mode === 'listener') process.exit(37);
      };
      if (mode === 'listener' || mode === 'handled' || mode === 'removed') process.once('SIGTERM', listener);
      if (mode === 'exit') process.stdin.once('data', () => process.exit(37));
      const pending = Promise.all(attempts.map(async (attempt) => {
        if (mode === 'denied-exit') attempt.internal = { killGroup: () => { throw Object.assign(new Error('group signal denied'), { code: 'EPERM' }); } };
        try { appendFileSync(outcomes, await addWorktree(attempt)); }
        catch (error) {
          appendFileSync(outcomes, error.message + '\\n');
          if (mode === 'denied-exit') process.exit(37);
        }
      }));
      if (mode === 'late') process.once('SIGTERM', listener);
      if (mode === 'late-prepended') process.prependOnceListener('SIGTERM', listener);
      if (mode === 'removed') process.off('SIGTERM', listener);
      await pending;
    `;
    const sender = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, JSON.stringify([attempts, mode, outcomes, handled])], {
      env: { ...process.env, OUTSRC_GIT_COW_TIMEOUT_MS: mode === "denied-exit" ? "1000" : "600000" }, stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    sender.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      sender.once("error", reject);
      sender.once("exit", (code, signal) => resolve({ code, signal }));
    });
    const groups = () => existsSync(join(f.bin, "groups.jsonl")) ? readFileSync(join(f.bin, "groups.jsonl"), "utf8").trim().split("\n")
      .map((line) => z.object({ stub: z.number().int().positive(), child: z.number().int().positive() }).parse(JSON.parse(line))) : [];
    try {
      await expect.poll(() => groups().length).toBe(attempts.length);
      for (const attempt of attempts) expect(git(attempt.worktree, "branch", "--show-current")).toBe(`${attempt.branch}\n`);
      const signal = mode === "SIGINT" ? "SIGINT" : mode === "SIGHUP" ? "SIGHUP" : "SIGTERM";
      if (mode === "exit") sender.stdin.write("exit\n"); else if (mode !== "denied-exit") sender.kill(signal);
      await expect.poll(() => sender.exitCode !== null || sender.signalCode !== null, { timeout: 5000 }).toBe(true);
      expect(await exited).toEqual(mode === "listener" || mode === "exit" || mode === "denied-exit" ? { code: 37, signal: null }
        : mode === "handled" || mode === "late" || mode === "late-prepended" ? { code: 0, signal: null } : { code: null, signal });
      expect(stderr).toBe("");
      if (mode === "listener" || mode === "handled" || mode === "late" || mode === "late-prepended") expect(readFileSync(handled, "utf8")).toBe("handled once\n");
      if (mode === "handled" || mode === "late" || mode === "late-prepended") expect(readFileSync(outcomes, "utf8")).toBe("git-cow interrupted by SIGTERM\n");
      if (mode === "denied-exit") expect(readFileSync(outcomes, "utf8")).toBe("group signal denied\n");
      for (const { stub, child } of groups()) {
        for (const pid of [stub, child]) await expect.poll(() => {
          try { process.kill(pid, 0); return "alive"; }
          catch (error) { return error instanceof Error && "code" in error ? error.code : "unknown"; }
        }, { timeout: 2000, interval: 20 }).toBe("ESRCH");
      }
      for (const attempt of attempts) {
        expect(existsSync(attempt.worktree)).toBe(false);
        expect(git(f.repo, "branch", "--list", attempt.branch)).toBe("");
      }
      const registrations = git(f.repo, "worktree", "list", "--porcelain", "-z").split("\0").filter((entry) => entry.startsWith("worktree "));
      expect(registrations.sort()).toEqual([`worktree ${f.repo}`, `worktree ${f.helper}`].sort());
      expectHelper(f);
    } finally {
      sender.kill("SIGKILL");
      await exited;
      for (const { stub, child } of groups()) for (const pid of [stub, child]) { try { process.kill(pid, "SIGKILL"); } catch {} }
    }
  });

  test.skipIf(process.platform === "win32").each(["success", "partial"])("%s creation restores the original signal and exit listeners", async (mode) => {
    const f = fixture(mode);
    const signals = ["SIGINT", "SIGTERM", "SIGHUP", "exit", "newListener"];
    const listeners = signals.map((signal) => process.rawListeners(signal));
    expect(await addWorktree({ ...f, command: "git-cow" })).toBe(mode === "success" ? "git-cow" : "git (fallback: git-cow exited 7)");
    expect(signals.map((signal) => process.rawListeners(signal))).toEqual(listeners);
    expectWorktree(f);
  });

  test.each([undefined, "", " ", "\t", "0", "-1", "1.5", "0x10", "1e3", "2147483648", "99999999999999999999999", "1\n", "+1"])("invalid timeout override %j uses the default", (value) => {
    expect(parseGitCowTimeout(value)).toBe(600_000);
  });

  test.each([["1", 1], ["0010", 10], ["1000", 1000], ["2147483647", 2147483647]])("decimal timeout override %s is accepted", (value, timeout) => {
    expect(parseGitCowTimeout(String(value))).toBe(timeout);
  });

  test("an invalid timeout override does not fail worktree creation", async () => {
    const f = fixture();
    vi.stubEnv("OUTSRC_GIT_COW_TIMEOUT_MS", "1.5");
    expect(await addWorktree({ ...f, command: "git-cow" })).toBe("git-cow");
    expectWorktree(f);
    expectHelper(f);
  });

  test.skipIf(process.platform === "win32")("a group gone after SIGTERM still falls back on timeout", async () => {
    const f = fixture("timeout-term");
    vi.stubEnv("OUTSRC_GIT_COW_TIMEOUT_MS", "1000");
    try {
      expect(await addWorktree({ ...f, command: "git-cow" })).toBe("git (fallback: git-cow timed out)");
      expect(readFileSync(join(f.bin, "terminated"), "utf8")).toBe("SIGTERM\n");
      expectWorktree(f);
      expectHelper(f);
    } finally {
      if (existsSync(join(f.bin, "stub.pid"))) { try { process.kill(Number(readFileSync(join(f.bin, "stub.pid"), "utf8")), "SIGKILL"); } catch {} }
    }
  });

  test.skipIf(process.platform === "win32")("EPERM rejects without cleanup or plain-git fallback", async () => {
    const f = fixture("signal-error");
    vi.stubEnv("OUTSRC_GIT_COW_TIMEOUT_MS", "1000");
    const denied = Object.assign(new Error("group signal denied"), { code: "EPERM" });
    let group: number | undefined;
    const signals = ["SIGINT", "SIGTERM", "SIGHUP", "exit", "newListener"];
    const listeners = signals.map((signal) => process.rawListeners(signal));
    const attempt = addWorktree({ ...f, command: "git-cow", internal: { killGroup: (pid) => { group = pid; throw denied; } } });
    const rejected = expect(attempt).rejects.toBe(denied);
    try {
      await expect.poll(() => existsSync(join(f.bin, "ready"))).toBe(true);
      const admin = git(f.worktree, "rev-parse", "--absolute-git-dir").trim();
      const gitdir = readFileSync(join(admin, "gitdir"), "utf8");
      await rejected;
      expect(readFileSync(join(f.worktree, "partial"), "utf8")).toBe("unfinished clone\n");
      expect(readFileSync(join(admin, "gitdir"), "utf8")).toBe(gitdir);
      expectWorktree(f);
      expectHelper(f);
    } finally {
      if (group !== undefined) { try { process.kill(-group, "SIGKILL"); } catch {} }
      await attempt.catch(() => {});
      await expect.poll(() => signals.map((signal) => process.rawListeners(signal))).toEqual(listeners);
    }
  });

  test.skipIf(process.platform === "win32" || !sessionTool || !sleep).each(["escapeok", "escape"])("%s settles without waiting for escaped inherited pipes", async (mode) => {
    const f = fixture(mode);
    if (!sessionTool || !sleep) throw new Error("session tool and sleep are required");
    const pidFile = join(f.bin, "escaped.pid");
    const args = basename(sessionTool) === "perl"
      ? ["-MPOSIX", "-e", 'POSIX::setsid() >= 0 or die $!; open(my $fh, ">", shift @ARGV) or die $!; print $fh $$; close $fh; exec @ARGV;', pidFile, sleep, "25"]
      : ["-c", 'import os,sys; os.setsid(); open(sys.argv[1],"w").write(str(os.getpid())); os.execv(sys.argv[2],sys.argv[2:])', pidFile, sleep, "25"];
    writeFileSync(join(f.bin, "session.json"), JSON.stringify({ command: sessionTool, args }));
    vi.stubEnv("OUTSRC_GIT_COW_TIMEOUT_MS", "1000");
    const started = Date.now();
    const attempt = addWorktree({ ...f, command: "git-cow" });
    try {
      const deadline = new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("escaped pipes blocked settlement for 5 seconds")), 5000);
        void attempt.finally(() => clearTimeout(timer)).catch(() => {});
      });
      expect(await Promise.race([attempt, deadline])).toBe(mode === "escapeok" ? "git-cow" : "git (fallback: git-cow timed out)");
      expect(Date.now() - started).toBeLessThan(5000);
      expectWorktree(f);
      expectHelper(f);
    } finally {
      if (existsSync(pidFile)) { try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch {} }
      await attempt;
    }
  });

  test("default uses plain git even when git-cow is available", async () => {
    const f = fixture();
    expect(await addWorktree(f)).toBe("git");
    expect(git(f.worktree, "branch", "--show-current")).toBe("agent/job\n");
    expect(readFileSync(join(f.worktree, "README.md"), "utf8")).toBe("fixture\n");
    expect(f.calls()).toEqual([]);
  });

  test.each([undefined, "HEAD~1"])("git-cow receives exact arguments for ref %s and review settings stay hidden", async (ref) => {
    const f = fixture();
    expect(await addWorktree({ ...f, command: "git-cow", ...(ref ? { ref } : {}) })).toBe("git-cow");
    expect(f.calls()).toEqual([["add", "-b", "agent/job", f.worktree, ref ?? "HEAD"]]);
    expectWorktree(f);
    expect(git(f.worktree, "rev-parse", "HEAD")).toBe(git(f.repo, "rev-parse", ref ?? "HEAD"));
    if (!ref) {
      expect(hideAgentConfig(f.worktree)).toEqual([".claude/settings.json"]);
      expect(existsSync(join(f.worktree, ".claude/settings.json"))).toBe(false);
      expect(git(f.worktree, "show", "HEAD:.claude/settings.json")).toBe('{"hooks":{}}\n');
      expect(git(f.worktree, "status", "--porcelain")).toBe("");
      expect(readFileSync(join(f.helper, ".claude/settings.json"), "utf8")).toBe('{"hooks":{}}\n');
    }
    expectHelper(f);
  });

  test.each(["missing", "not-executable"])("%s git-cow falls back to plain git", async (mode) => {
    const f = fixture(mode);
    expect(await addWorktree({ ...f, command: "git-cow" })).toBe("git (fallback: git-cow not found in git exec-path or PATH)");
    expect(git(f.worktree, "branch", "--show-current")).toBe("agent/job\n");
    expect(f.calls()).toEqual([]);
  });

  test("finds git-cow in Git's exec path without it being on PATH", async () => {
    const f = fixture();
    renameSync(join(f.bin, "git-cow"), join(f.execPath, "git-cow"));
    renameSync(join(f.bin, "mode"), join(f.execPath, "mode"));
    expect(await addWorktree({ ...f, command: "git-cow" })).toBe("git-cow");
    expect(readFileSync(join(f.execPath, "calls.jsonl"), "utf8")).toBe(`${JSON.stringify(["add", "-b", "agent/job", f.worktree, "HEAD"])}\n`);
    expectWorktree(f);
    expectHelper(f);
  });

  test.each(["partial", "broken", "folder", "branch"])("cleans up a %s attempt before fallback without touching the helper", async (mode) => {
    const f = fixture(mode);
    expect(await addWorktree({ ...f, command: "git-cow" })).toBe("git (fallback: git-cow exited 7)");
    expectWorktree(f);
    expect(existsSync(join(f.worktree, "partial"))).toBe(false);
    expectHelper(f);
    expect(f.calls()).toEqual([["add", "-b", f.branch, f.worktree, "HEAD"]]);
  });

  test.each(["partial", "broken"])("a %s failure preserves unrelated missing worktree registrations", async (mode) => {
    const f = fixture(mode);
    const unrelated = ["unlocked", "locked"].map((name) => {
      const path = join(f.home, name);
      git(f.repo, "worktree", "add", "-b", name, path);
      if (name === "locked") git(f.repo, "worktree", "lock", "--reason", "unmounted drive", path);
      const admin = git(path, "rev-parse", "--absolute-git-dir").trim();
      const files = ["gitdir", "HEAD", ...(name === "locked" ? ["locked"] : [])]
        .map((file) => ({ file, contents: readFileSync(join(admin, file), "utf8") }));
      rmSync(path, { recursive: true });
      return { path, admin, files };
    });
    mkdirSync(dirname(f.worktree), { recursive: true });
    const alias = join(f.home, "aliased-parent");
    symlinkSync(dirname(f.worktree), alias);
    expect(await addWorktree({ ...f, worktree: join(alias, basename(f.worktree)), command: "git-cow" }))
      .toBe("git (fallback: git-cow exited 7)");
    expect(git(f.worktree, "branch", "--show-current")).toBe("agent/job\n");
    expect(readFileSync(join(f.worktree, "README.md"), "utf8")).toBe("fixture\n");
    for (const { admin, files } of unrelated) {
      for (const { file, contents } of files) expect(readFileSync(join(admin, file), "utf8")).toBe(contents);
    }
    const registrations = git(f.repo, "worktree", "list", "--porcelain", "-z").split("\0").filter((entry) => entry.startsWith("worktree "));
    expect(registrations.sort()).toEqual([f.repo, f.helper, f.worktree, ...unrelated.map(({ path }) => path)].map((path) => `worktree ${path}`).sort());
    expectHelper(f);
  });

  test.each([
    ["stderr", `clone failed: ${"x".repeat(186)}`],
    ["stdout", "stdout clone failure"],
  ])("fallback records normalized and capped %s diagnostics", async (mode, diagnostic) => {
    const f = fixture(mode);
    const method = await addWorktree({ ...f, command: "git-cow" });
    expect(method).toBe(`git (fallback: git-cow exited 7: ${diagnostic})`);
    expect(WorktreeMethodSchema.parse(method)).toBe(method);
    expectWorktree(f);
    expectHelper(f);
  });

  test("broken cleanup preserves earlier-sorting user and helper registrations", async () => {
    const f = fixture("broken");
    const unrelated = [join(f.home, "aaa-unrelated"), join(dirname(f.helper), "aab-helper")].map((path) => {
      git(f.repo, "worktree", "add", "--detach", path);
      const admin = git(path, "rev-parse", "--absolute-git-dir").trim();
      const gitdir = readFileSync(join(admin, "gitdir"), "utf8");
      return { path, admin, gitdir };
    });
    expect(unrelated.map(({ admin }) => basename(admin))).toEqual(["aaa-unrelated", "aab-helper"]);
    expect(await addWorktree({ ...f, command: "git-cow" })).toBe("git (fallback: git-cow exited 7)");
    for (const { path, admin, gitdir } of unrelated) {
      expect(readFileSync(join(admin, "gitdir"), "utf8")).toBe(gitdir);
      expect(readFileSync(join(path, "README.md"), "utf8")).toBe("fixture\n");
      expect(git(path, "rev-parse", "HEAD")).toBe(git(f.repo, "rev-parse", "HEAD"));
    }
    const admin = git(f.worktree, "rev-parse", "--absolute-git-dir").trim();
    expect(existsSync(join(admin, "failed-attempt"))).toBe(false);
    expect(git(f.worktree, "branch", "--show-current")).toBe("agent/job\n");
    const registrations = git(f.repo, "worktree", "list", "--porcelain", "-z").split("\0").filter((entry) => entry.startsWith("worktree "));
    expect(registrations.sort()).toEqual([f.repo, f.helper, f.worktree, ...unrelated.map(({ path }) => path)].map((path) => `worktree ${path}`).sort());
    expectHelper(f);
  });

  test("cleans a broken registration when the repository is itself a linked worktree", async () => {
    const f = fixture("broken");
    const repo = join(f.home, "linked", "repo");
    git(f.repo, "worktree", "add", "--detach", repo);
    expect(await addWorktree({ ...f, repo, command: "git-cow" })).toBe("git (fallback: git-cow exited 7)");
    expect(git(f.worktree, "branch", "--show-current")).toBe("agent/job\n");
    expect(readFileSync(join(f.worktree, "README.md"), "utf8")).toBe("fixture\n");
    const registrations = git(f.repo, "worktree", "list", "--porcelain", "-z").split("\0").filter((entry) => entry.startsWith("worktree "));
    expect(registrations.sort()).toEqual([f.repo, repo, f.helper, f.worktree].map((path) => `worktree ${path}`).sort());
    expectHelper(f);
  });

  test("an executable that cannot start records the Git diagnostic before fallback", async () => {
    const f = fixture();
    writeFileSync(join(f.bin, "git-cow"), "#!/no/such/interpreter\n");
    expect(await addWorktree({ ...f, command: "git-cow" })).toMatch(/^git \(fallback: git-cow exited 128: [^\n]*(cannot exec|not able to execute)[^\n]*\)$/);
    expect(git(f.worktree, "branch", "--show-current")).toBe("agent/job\n");
  });

  test.skipIf(process.platform === "win32").each(["timeout", "timeout-orphan", "failed-child"])("%s kills the stub and its TERM-resistant child before fallback", async (mode) => {
    const f = fixture(mode);
    vi.stubEnv("OUTSRC_GIT_COW_TIMEOUT_MS", "1000");
    const attempt = addWorktree({ ...f, command: "git-cow" });
    const pids: number[] = [];
    try {
      await expect.poll(() => existsSync(join(f.bin, "stub.pid"))).toBe(true);
      for (const name of ["stub", "child"]) pids.push(Number(readFileSync(join(f.bin, `${name}.pid`), "utf8")));
      expect(await attempt).toBe(mode === "failed-child" ? "git (fallback: git-cow exited 7)" : "git (fallback: git-cow timed out)");
      for (const pid of pids) {
        await expect.poll(() => {
          try { process.kill(pid, 0); return "alive"; }
          catch (error) { return error instanceof Error && "code" in error ? error.code : "unknown"; }
        }, { timeout: 500, interval: 20 }).toBe("ESRCH");
      }
      if (mode !== "failed-child") expect(readFileSync(join(f.bin, "terminated"), "utf8")).toBe("SIGTERM\n");
      expectWorktree(f);
      expectHelper(f);
      expect(f.calls()).toEqual([["add", "-b", f.branch, f.worktree, "HEAD"]]);
    } finally {
      for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch {} }
      await attempt;
    }
  });

  test.each([false, true])("holds the launch reservation during async creation and releases it after wrapper failure=%s", async (failWrapper) => {
    const f = fixture("waiting");
    vi.stubEnv("OUTSRC_GIT_COW_TIMEOUT_MS", "5000");
    const ctx = testCtx(f.home, f.repo);
    ctx.config.worktree = { command: "git-cow" };
    ctx.config.limits = { maxJobs: 1, maxRunMinutes: 120 };
    ctx.wrapperCommand = failWrapper ? [join(f.home, "missing-wrapper")] : [process.execPath, "-e", "process.exit(0)", "--"];
    const request = { repo: "demo", target: "fake", message: "work", request_id: "preparing" };
    const pending = createMailbox(ctx).send(request);
    try {
      await expect.poll(() => existsSync(join(f.bin, "ready"))).toBe(true);
      const directories = readdirSync(join(f.home, "threads"));
      expect(directories).toHaveLength(1);
      const directory = join(f.home, "threads", directories[0] ?? "missing");
      const lock = join(directory, "launch.lock");
      expect(readFileSync(lock, "utf8")).toBe(String(process.pid));
      expect(existsSync(join(directory, "thread.json"))).toBe(false);
      expect(await createMailbox(ctx).send({ repo: "demo", target: "fake", message: "second" }))
        .toEqual({ ok: false, error: "active job limit reached (1); the owner can change it with outsrc config set limits.max_jobs <n>" });
      ctx.config.limits.maxJobs = 2;
      const receipt = join(f.home, "requests", requestFileName(undefined, "preparing"));
      const savedReceipt = readFileSync(receipt, "utf8");
      expect(await createMailbox(ctx).send(request)).toEqual({ ok: false, error: "request is still preparing; retry the same request_id" });
      expect(readFileSync(receipt, "utf8")).toBe(savedReceipt);
      expect(readFileSync(lock, "utf8")).toBe(String(process.pid));
      writeFileSync(join(f.bin, "release"), "release\n");
      const sent = await pending;
      if (!sent.ok) throw new Error(sent.error);
      expect(ThreadSchema.parse(readJson(join(directory, "thread.json"))).worktreeMethod).toBe("git-cow");
      expect(existsSync(lock)).toBe(false);
      if (failWrapper) expect(createMailbox(ctx).inbox(sent.thread_id)).toMatchObject({ status: "failed", message: expect.stringContaining("ENOENT") });
    } finally {
      writeFileSync(join(f.bin, "release"), "release\n");
      await pending;
    }
  });

  test("a live launch lock protects an old published run until wrapper startup finishes", async () => {
    const f = fixture();
    const ctx = testCtx(f.home, f.repo);
    ctx.wrapperCommand = [process.execPath, "-e", "process.exit(0)", "--"];
    const box = createMailbox(ctx);
    const sent = await box.send({ repo: "demo", target: "fake", message: "work" });
    if (!sent.ok) throw new Error(sent.error);
    const directory = join(f.home, "threads", sent.thread_id);
    const runDir = join(directory, "runs", sent.run_id);
    rmSync(join(runDir, "process.json"), { force: true });
    const runFile = join(runDir, "run.json");
    const run = RunSchema.parse(readJson(runFile));
    writeJson(runFile, { ...run, createdAt: "2000-01-01T00:00:00.000Z" });
    const lock = join(directory, "launch.lock");
    writeFileSync(lock, String(process.pid));
    expect(box.inbox(sent.thread_id)).toMatchObject({ status: "working" });
    expect(existsSync(join(runDir, "result.json"))).toBe(false);
    rmSync(lock);
    expect(box.inbox(sent.thread_id)).toMatchObject({ status: "failed", message: "Task startup was interrupted before the wrapper started" });
  });

  test("cleans a failed attempt in a pre-existing empty directory before fallback", async () => {
    const f = fixture("partial");
    mkdirSync(f.worktree, { recursive: true });
    expect(await addWorktree({ ...f, command: "git-cow" })).toBe("git (fallback: git-cow exited 7)");
    expectWorktree(f);
    expectHelper(f);
  });

  test.each(["branch", "directory", "both"])("a failed attempt preserves a pre-existing %s", async (existing) => {
    const f = fixture("partial");
    if (existing !== "directory") git(f.repo, "branch", f.branch, "HEAD~1");
    if (existing !== "branch") {
      mkdirSync(f.worktree, { recursive: true });
      writeFileSync(join(f.worktree, "keep"), "existing work\n");
    }
    await expect(addWorktree({ ...f, command: "git-cow" })).rejects.toThrow();
    if (existing !== "directory") expect(git(f.repo, "rev-parse", f.branch)).toBe(git(f.repo, "rev-parse", "HEAD~1"));
    if (existing !== "branch") expect(readFileSync(join(f.worktree, "keep"), "utf8")).toBe("existing work\n");
    expectHelper(f);
  });

  test.skipIf(!realCow)("real git-cow creates a valid worktree and its helper checkout", async () => {
    const f = fixture();
    vi.stubEnv("PATH", originalPath);
    vi.stubEnv("GIT_EXEC_PATH", originalExecPath);
    expect(await addWorktree({ ...f, command: "git-cow" })).toBe("git-cow");
    expectWorktree(f);
    expect(readFileSync(join(f.helper, "README.md"), "utf8")).toBe("fixture\n");
    expect(hideAgentConfig(f.worktree)).toEqual([".claude/settings.json"]);
    expect(git(f.worktree, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(f.helper, ".claude/settings.json"), "utf8")).toBe('{"hooks":{}}\n');
  });
});

describe.each<WorktreeCommand>(["git", "git-cow"])("%s thread lifecycle", (command) => {
  test.each(["discard", "prune", "unregistered"])("migrates a legacy worktree then removes it with %s without touching the helper", async (removal) => {
    const f = fixture();
    await addWorktree({ ...f, branch: "helper-seed", command: "git-cow" });
    git(f.repo, "worktree", "remove", "--force", f.worktree);
    await addWorktree({ ...f, command });
    const id = "0123456789abcdef";
    const directory = join(f.home, "threads", id);
    mkdirSync(directory, { recursive: true });
    writeJson(join(directory, "thread.json"), {
      id, repo: "demo", target: "fake", model: null, effort: null, status: "succeeded",
      worktree: f.worktree, branch: f.branch, pid: 0, pgid: 0, createdAt: "2000-01-01T00:00:00.000Z",
    });
    writeFileSync(join(directory, "exit_code"), "0");
    writeFileSync(join(directory, "summary.md"), "Saved result\n");
    const ctx = testCtx(f.home, f.repo);
    expect(migrateLegacy(ctx)).toEqual({ migrated: [id], skipped: [] });
    expect(migrateLegacy(ctx)).toEqual({ migrated: [], skipped: [] });
    const box = createMailbox(ctx);
    expect(box.inbox(id)).toMatchObject({ status: "succeeded", message: "Saved result", worktree_method: null });
    expect(box.threads().threads.map((thread) => thread.thread_id)).toEqual([id]);
    expectHelper(f);
    if (removal === "unregistered") {
      git(f.repo, "worktree", "remove", "--force", f.worktree);
      mkdirSync(f.worktree);
      writeFileSync(join(f.worktree, "partial"), "leftover\n");
    }
    if (removal === "prune") {
      const repo = ctx.config.repos[0];
      if (!repo) throw new Error("fixture repository missing");
      repo.retentionDays = 1;
      const resultFile = join(directory, "runs", "legacy", "result.json");
      writeJson(resultFile, { ...ResultSchema.parse(readJson(resultFile)), finishedAt: "2000-01-01T00:00:00.000Z" });
      expect(box.prune()).toEqual({ removed: [id] });
      expect(box.prune()).toEqual({ removed: [] });
    } else expect(box.discard(id)).toEqual({ ok: true, discarded: true, thread_id: id });
    expect(existsSync(f.worktree)).toBe(false);
    expect(git(f.repo, "branch", "--list", f.branch)).toBe("");
    expectHelper(f);
  });

  test("records the method, resumes, prunes and discards while preserving the helper", async () => {
    const f = fixture();
    await addWorktree({ ...f, command: "git-cow" });
    git(f.repo, "worktree", "remove", "--force", f.worktree);
    const ctx = testCtx(f.home, f.repo);
    ctx.config.worktree = { command };
    const repo = ctx.config.repos[0];
    if (!repo) throw new Error("fixture repository missing");
    repo.retentionDays = 1;
    const box = createMailbox(ctx);
    const sent = await box.send({ repo: "demo", target: "fake", message: "review", kind: "review" });
    if (!sent.ok) throw new Error(sent.error);
    await expect.poll(() => box.inbox(sent.thread_id)).toMatchObject({ status: "succeeded", worktree_method: command });
    const threadFile = join(f.home, "threads", sent.thread_id, "thread.json");
    const thread = ThreadSchema.parse(readJson(threadFile));
    expect(thread.worktreeMethod).toBe(command);
    expect(existsSync(join(thread.worktree, ".claude/settings.json"))).toBe(false);
    expect(git(thread.worktree, "show", "HEAD:.claude/settings.json")).toBe('{"hooks":{}}\n');
    expect(box.threads().threads.map((item) => ({ id: item.thread_id, method: item.worktree_method }))).toEqual([{ id: sent.thread_id, method: command }]);
    expect(box.log({ thread_id: sent.thread_id })).toMatchObject({ ok: true, text: expect.stringContaining(`Worktree method: ${command}\n`) });
    const resumed = await createMailbox(ctx).send({ thread_id: sent.thread_id, message: "continue" });
    if (!resumed.ok) throw new Error(resumed.error);
    await expect.poll(() => box.inbox(sent.thread_id)).toMatchObject({ status: "succeeded", worktree_method: command });
    expect(box.log({ thread_id: sent.thread_id })).toMatchObject({ text: expect.stringContaining(`Worktree method: ${command}\n`) });
    const resultFile = join(f.home, "threads", sent.thread_id, "runs", resumed.run_id, "result.json");
    writeJson(resultFile, { ...ResultSchema.parse(readJson(resultFile)), finishedAt: "2000-01-01T00:00:00.000Z" });
    const calls = f.calls();
    expect(box.prune()).toEqual({ removed: [sent.thread_id] });
    expect(box.prune()).toEqual({ removed: [] });
    expect(box.discard(sent.thread_id)).toEqual({ ok: true, discarded: true, thread_id: sent.thread_id });
    expect(existsSync(thread.worktree)).toBe(false);
    expect(git(f.repo, "branch", "--list", thread.branch)).toBe("");
    expect(git(f.repo, "worktree", "list", "--porcelain", "-z").split("\0").filter((entry) => entry.startsWith("worktree ")).sort())
      .toEqual([`worktree ${f.repo}`, `worktree ${f.helper}`].sort());
    expect(f.calls()).toEqual(calls);
    expectHelper(f);
    expect(migrateLegacy({ home: f.home, config: ctx.config })).toEqual({ migrated: [], skipped: [] });
    expectHelper(f);
  });
});

test.each(["missing", "partial"])("%s fallback is recorded in thread, inbox and run log", async (mode) => {
  const f = fixture(mode);
  const ctx = testCtx(f.home, f.repo);
  ctx.config.worktree = { command: "git-cow" };
  const box = createMailbox(ctx);
  const sent = await box.send({ repo: "demo", target: "fake", message: "work" });
  if (!sent.ok) throw new Error(sent.error);
  const method = mode === "missing" ? "git (fallback: git-cow not found in git exec-path or PATH)" : "git (fallback: git-cow exited 7)";
  await expect.poll(() => box.inbox(sent.thread_id)).toMatchObject({ status: "succeeded", worktree_method: method });
  expect(ThreadSchema.parse(readJson(join(f.home, "threads", sent.thread_id, "thread.json"))).worktreeMethod).toBe(method);
  expect(box.threads().threads).toMatchObject([{ worktree_method: method }]);
  expect(box.log({ thread_id: sent.thread_id })).toMatchObject({ ok: true, text: expect.stringContaining(`Worktree method: ${method}\n`) });
});
