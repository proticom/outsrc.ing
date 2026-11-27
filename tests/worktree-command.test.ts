import childProcess, { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { addWorktree, hideAgentConfig, WorktreeMethodSchema, type WorktreeCommand } from "../src/git.ts";
import { createMailbox } from "../src/mailbox.ts";
import { migrateLegacy } from "../src/migrate.ts";
import { readJson, ResultSchema, ThreadSchema, writeJson } from "../src/state.ts";
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
  test("default uses plain git even when git-cow is available", () => {
    const f = fixture();
    expect(addWorktree(f)).toBe("git");
    expect(git(f.worktree, "branch", "--show-current")).toBe("agent/job\n");
    expect(readFileSync(join(f.worktree, "README.md"), "utf8")).toBe("fixture\n");
    expect(f.calls()).toEqual([]);
  });

  test.each([undefined, "HEAD~1"])("git-cow receives exact arguments for ref %s and review settings stay hidden", (ref) => {
    const f = fixture();
    expect(addWorktree({ ...f, command: "git-cow", ...(ref ? { ref } : {}) })).toBe("git-cow");
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

  test.each(["missing", "not-executable"])("%s git-cow falls back to plain git", (mode) => {
    const f = fixture(mode);
    expect(addWorktree({ ...f, command: "git-cow" })).toBe("git (fallback: git-cow not found in git exec-path or PATH)");
    expect(git(f.worktree, "branch", "--show-current")).toBe("agent/job\n");
    expect(f.calls()).toEqual([]);
  });

  test("finds git-cow in Git's exec path without it being on PATH", () => {
    const f = fixture();
    renameSync(join(f.bin, "git-cow"), join(f.execPath, "git-cow"));
    renameSync(join(f.bin, "mode"), join(f.execPath, "mode"));
    expect(addWorktree({ ...f, command: "git-cow" })).toBe("git-cow");
    expect(readFileSync(join(f.execPath, "calls.jsonl"), "utf8")).toBe(`${JSON.stringify(["add", "-b", "agent/job", f.worktree, "HEAD"])}\n`);
    expectWorktree(f);
    expectHelper(f);
  });

  test.each(["partial", "broken", "folder", "branch"])("cleans up a %s attempt before fallback without touching the helper", (mode) => {
    const f = fixture(mode);
    expect(addWorktree({ ...f, command: "git-cow" })).toBe("git (fallback: git-cow exited 7)");
    expectWorktree(f);
    expect(existsSync(join(f.worktree, "partial"))).toBe(false);
    expectHelper(f);
    expect(f.calls()).toEqual([["add", "-b", f.branch, f.worktree, "HEAD"]]);
  });

  test.each(["partial", "broken"])("a %s failure preserves unrelated missing worktree registrations", (mode) => {
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
    expect(addWorktree({ ...f, worktree: join(alias, basename(f.worktree)), command: "git-cow" }))
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
  ])("fallback records normalized and capped %s diagnostics", (mode, diagnostic) => {
    const f = fixture(mode);
    const method = addWorktree({ ...f, command: "git-cow" });
    expect(method).toBe(`git (fallback: git-cow exited 7: ${diagnostic})`);
    expect(WorktreeMethodSchema.parse(method)).toBe(method);
    expectWorktree(f);
    expectHelper(f);
  });

  test("cleans a broken registration when the repository is itself a linked worktree", () => {
    const f = fixture("broken");
    const repo = join(f.home, "linked", "repo");
    git(f.repo, "worktree", "add", "--detach", repo);
    expect(addWorktree({ ...f, repo, command: "git-cow" })).toBe("git (fallback: git-cow exited 7)");
    expect(git(f.worktree, "branch", "--show-current")).toBe("agent/job\n");
    expect(readFileSync(join(f.worktree, "README.md"), "utf8")).toBe("fixture\n");
    const registrations = git(f.repo, "worktree", "list", "--porcelain", "-z").split("\0").filter((entry) => entry.startsWith("worktree "));
    expect(registrations.sort()).toEqual([f.repo, repo, f.helper, f.worktree].map((path) => `worktree ${path}`).sort());
    expectHelper(f);
  });

  test("an executable that cannot start records the Git diagnostic before fallback", () => {
    const f = fixture();
    writeFileSync(join(f.bin, "git-cow"), "#!/no/such/interpreter\n");
    expect(addWorktree({ ...f, command: "git-cow" })).toMatch(/^git \(fallback: git-cow exited 128: [^\n]*(cannot exec|not able to execute)[^\n]*\)$/);
    expect(git(f.worktree, "branch", "--show-current")).toBe("agent/job\n");
  });

  test("a timed-out git-cow attempt is cleaned up before fallback", () => {
    const f = fixture("timeout");
    const execute = execFileSync;
    const spy = vi.spyOn(childProcess, "execFileSync").mockImplementation((file, args, options) => {
      if (file === "git" && args?.[0] === "cow") {
        expect(options).toMatchObject({ timeout: 600_000 });
        return execute(file, args, { ...options, timeout: 1000 });
      }
      return execute(file, args, options);
    });
    syncBuiltinESMExports();
    try {
      expect(addWorktree({ ...f, command: "git-cow" })).toBe("git (fallback: git-cow timed out)");
      expectWorktree(f);
      expectHelper(f);
      expect(f.calls()).toEqual([["add", "-b", f.branch, f.worktree, "HEAD"]]);
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
    }
  });

  test("cleans a failed attempt in a pre-existing empty directory before fallback", () => {
    const f = fixture("partial");
    mkdirSync(f.worktree, { recursive: true });
    expect(addWorktree({ ...f, command: "git-cow" })).toBe("git (fallback: git-cow exited 7)");
    expectWorktree(f);
    expectHelper(f);
  });

  test.each(["branch", "directory", "both"])("a failed attempt preserves a pre-existing %s", (existing) => {
    const f = fixture("partial");
    if (existing !== "directory") git(f.repo, "branch", f.branch, "HEAD~1");
    if (existing !== "branch") {
      mkdirSync(f.worktree, { recursive: true });
      writeFileSync(join(f.worktree, "keep"), "existing work\n");
    }
    expect(() => addWorktree({ ...f, command: "git-cow" })).toThrow();
    if (existing !== "directory") expect(git(f.repo, "rev-parse", f.branch)).toBe(git(f.repo, "rev-parse", "HEAD~1"));
    if (existing !== "branch") expect(readFileSync(join(f.worktree, "keep"), "utf8")).toBe("existing work\n");
    expectHelper(f);
  });

  test.skipIf(!realCow)("real git-cow creates a valid worktree and its helper checkout", () => {
    const f = fixture();
    vi.stubEnv("PATH", originalPath);
    vi.stubEnv("GIT_EXEC_PATH", originalExecPath);
    expect(addWorktree({ ...f, command: "git-cow" })).toBe("git-cow");
    expectWorktree(f);
    expect(readFileSync(join(f.helper, "README.md"), "utf8")).toBe("fixture\n");
    expect(hideAgentConfig(f.worktree)).toEqual([".claude/settings.json"]);
    expect(git(f.worktree, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(f.helper, ".claude/settings.json"), "utf8")).toBe('{"hooks":{}}\n');
  });
});

describe.each<WorktreeCommand>(["git", "git-cow"])("%s thread lifecycle", (command) => {
  test.each(["discard", "prune", "unregistered"])("migrates a legacy worktree then removes it with %s without touching the helper", (removal) => {
    const f = fixture();
    addWorktree({ ...f, branch: "helper-seed", command: "git-cow" });
    git(f.repo, "worktree", "remove", "--force", f.worktree);
    addWorktree({ ...f, command });
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
    addWorktree({ ...f, command: "git-cow" });
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
