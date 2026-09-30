import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { createMailbox } from "../src/mailbox.ts";
import { initGitRepo, tempHome, testCtx } from "./helpers.ts";

describe("listRepos", () => {
  test("returns configured aliases", () => {
    const home = tempHome();
    const repo = join(home, "repo");
    initGitRepo(repo);
    const box = createMailbox(testCtx(home, repo));
    expect(box.listRepos()).toEqual({
      repos: [{ alias: "demo", path: repo }],
    });
  });
});

describe("send validation", () => {
  test("unknown repo errors and creates no threads", async () => {
    const home = tempHome();
    const repo = join(home, "repo");
    initGitRepo(repo);
    const box = createMailbox(testCtx(home, repo));
    const result = await box.send({
      repo: "nope",
      target: "fake",
      message: "do a thing",
    });
    expect(result).toEqual({ ok: false, error: "unknown repo: nope" });
    expect(existsSync(join(home, "threads"))).toBe(false);
  });

  test("unknown target errors", async () => {
    const home = tempHome();
    const repo = join(home, "repo");
    initGitRepo(repo);
    const box = createMailbox(testCtx(home, repo));
    const result = await box.send({
      repo: "demo",
      target: "codex",
      message: "do a thing",
    });
    expect(result).toEqual({ ok: false, error: "unknown target: codex" });
  });

  test("empty message errors", async () => {
    const home = tempHome();
    const repo = join(home, "repo");
    initGitRepo(repo);
    const box = createMailbox(testCtx(home, repo));
    const result = await box.send({
      repo: "demo",
      target: "fake",
      message: "   ",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error).toMatch(/message/);
  });

  test("model not on allowlist errors", async () => {
    const home = tempHome();
    const repo = join(home, "repo");
    initGitRepo(repo);
    const ctx = testCtx(home, repo);
    ctx.config.targets.fake!.models = {
      default: "good",
      allowed: ["good"],
    };
    const box = createMailbox(ctx);
    const result = await box.send({
      repo: "demo",
      target: "fake",
      message: "do a thing",
      model: "bad",
    });
    expect(result).toEqual({ ok: false, error: "model not allowed: bad" });
  });
});

describe("send and inbox", () => {
  test("delivers a thread then succeeds with diffstat", async () => {
    const home = tempHome();
    const repo = join(home, "repo");
    initGitRepo(repo);
    const box = createMailbox(testCtx(home, repo));
    const sent = await box.send({
      repo: "demo",
      target: "fake",
      message: "write the file",
    });
    expect(sent.ok).toBe(true);
    if (!sent.ok) throw new Error(sent.error);
    expect(sent.delivered).toBe(true);
    expect(sent.thread_id.length).toBeGreaterThan(4);

    const first = box.inbox(sent.thread_id);
    if (first.ok && first.status === "working") {
      expect(first.retry_after_seconds).toBe(1);
    }

    await expect
      .poll(() => {
        const r = box.inbox(sent.thread_id);
        return r.ok ? r.status : r.error;
      })
      .toBe("succeeded");

    const done = box.inbox(sent.thread_id);
    expect(done.ok).toBe(true);
    if (!done.ok || done.status === "working" || done.status === "needs_input") throw new Error("expected done");
    expect(done).toMatchObject({
      status: "succeeded", message: "Task completed", exit_code: 0,
      session_id: "fixture-session", findings: [], commit: null,
      run_id: sent.run_id, branch: `agent/outsrc-${sent.thread_id}`,
      worktree: join(home, "worktrees", "demo", sent.thread_id),
    });
    expect(done.diffstat.raw).toContain("task.txt");
    expect(readFileSync(join(done.worktree, "task.txt"), "utf8")).toBe("task result\n");

    const again = box.inbox(sent.thread_id);
    expect(again).toEqual(done);
  });
});

describe("send failures after validation", () => {
  test("missing command errors with no thread dir", async () => {
    const home = tempHome();
    const repo = join(home, "repo");
    initGitRepo(repo);
    const ctx = testCtx(home, repo);
    ctx.config.targets.fake!.command = join(home, "no-such-binary");
    const box = createMailbox(ctx);
    const result = await box.send({
      repo: "demo",
      target: "fake",
      message: "do a thing",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error).toMatch(/command not found/);
    expect(existsSync(join(home, "threads"))).toBe(false);
  });

  test("non-git repo path errors and leaves no thread", async () => {
    const home = tempHome();
    const repo = join(home, "not-git");
    mkdirSync(repo, { recursive: true });
    const box = createMailbox(testCtx(home, repo));
    const result = await box.send({
      repo: "demo",
      target: "fake",
      message: "do a thing",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error).toMatch(/not a git repository/);
    expect(existsSync(join(home, "threads"))).toBe(false);
  });
});

describe("inbox failed", () => {
  test("non-zero agent exit is failed and preserves partial work", async () => {
    const home = tempHome();
    const repo = join(home, "repo");
    initGitRepo(repo);
    const ctx = testCtx(home, repo, "fail");
    const box = createMailbox(ctx);
    const sent = await box.send({
      repo: "demo",
      target: "fake",
      message: "fail please",
    });
    expect(sent.ok).toBe(true);
    if (!sent.ok) throw new Error(sent.error);
    await expect
      .poll(() => {
        const r = box.inbox(sent.thread_id);
        return r.ok ? r.status : r.error;
      })
      .toBe("failed");
    const done = box.inbox(sent.thread_id);
    expect(done.ok).toBe(true);
    if (!done.ok || done.status === "working" || done.status === "needs_input") throw new Error("expected done");
    expect(done.exit_code).toBe(2);
    expect(done.message).toBe("Agent process exited with 2");
    expect(done.diffstat.raw).toContain("task.txt");
    expect(readFileSync(join(done.worktree, "task.txt"), "utf8")).toBe("partial result\n");
  });
});

describe("stop", () => {
  test("cancels a running agent", async () => {
    const home = tempHome();
    const repo = join(home, "repo");
    initGitRepo(repo);
    const ctx = testCtx(home, repo, "sleep");
    const box = createMailbox(ctx);
    const sent = await box.send({
      repo: "demo",
      target: "fake",
      message: "sleep",
    });
    expect(sent.ok).toBe(true);
    if (!sent.ok) throw new Error(sent.error);
    await expect
      .poll(() => {
        const r = box.inbox(sent.thread_id);
        return r.ok ? r.status : r.error;
      })
      .toBe("working");
    const stopped = box.stop(sent.thread_id);
    expect(stopped).toEqual({ ok: true, stopped: true });
    await expect
      .poll(() => {
        const r = box.inbox(sent.thread_id);
        return r.ok ? r.status : r.error;
      })
      .toBe("cancelled");
  });

  test("unknown thread errors", () => {
    const home = tempHome();
    const repo = join(home, "repo");
    initGitRepo(repo);
    const box = createMailbox(testCtx(home, repo));
    expect(box.stop("nope")).toEqual({
      ok: false,
      error: "thread_id must be 16 lowercase hex characters",
    });
    expect(box.stop("../../victim")).toEqual({
      ok: false,
      error: "thread_id must be 16 lowercase hex characters",
    });
    expect(box.stop("0123456789abcdef")).toEqual({
      ok: false,
      error: "unknown thread_id: 0123456789abcdef",
    });
  });
});

describe("needs_input", () => {
  test("inbox surfaces an ended-run question and follow-up send resumes its session", async () => {
    const home = tempHome();
    const repo = join(home, "repo");
    initGitRepo(repo);
    const ctx = testCtx(home, repo, "question");
    const box = createMailbox(ctx);
    const sent = await box.send({
      repo: "demo",
      target: "fake",
      message: "ask first",
    });
    expect(sent.ok).toBe(true);
    if (!sent.ok) throw new Error(sent.error);
    await expect
      .poll(() => {
        const r = box.inbox(sent.thread_id);
        return r.ok ? r.status : r.error;
      })
      .toBe("needs_input");
    const waiting = box.inbox(sent.thread_id);
    expect(waiting.ok).toBe(true);
    if (!waiting.ok || waiting.status !== "needs_input") {
      throw new Error("expected needs_input");
    }
    expect(waiting).toMatchObject({
      ok: true, status: "needs_input", retry_after_seconds: 0, run_id: sent.run_id,
      message: "Which color should the result use?", question_id: sent.run_id, session_id: "fixture-session",
      target: "fake", effort: null, model: null,
      usage: { tokens_in: null, tokens_out: null, estimated_cost_usd: null, wall_minutes: expect.any(Number) },
    });
    const answered = await box.send({
      thread_id: sent.thread_id,
      message: "Use green",
    });
    expect(answered).toMatchObject({
      ok: true,
      delivered: true,
      thread_id: sent.thread_id,
    });
    if (!answered.ok) throw new Error(answered.error);
    expect(answered.run_id).not.toBe(sent.run_id);
    await expect
      .poll(() => {
        const r = box.inbox(sent.thread_id);
        return r.ok ? r.status : r.error;
      })
      .toBe("succeeded");
    const done = box.inbox(sent.thread_id);
    expect(done.ok).toBe(true);
    if (!done.ok || done.status === "working" || done.status === "needs_input") {
      throw new Error("expected done");
    }
    expect(done.message).toBe("Applied the answer: green");
    expect(done.run_id).toBe(answered.run_id);
    expect(readFileSync(join(done.worktree, "answer.txt"), "utf8")).toBe("green\n");
  });

  test("follow-up on a working thread errors", async () => {
    const home = tempHome();
    const repo = join(home, "repo");
    initGitRepo(repo);
    const ctx = testCtx(home, repo, "sleep");
    const box = createMailbox(ctx);
    const sent = await box.send({
      repo: "demo",
      target: "fake",
      message: "sleep",
    });
    expect(sent.ok).toBe(true);
    if (!sent.ok) throw new Error(sent.error);
    await expect
      .poll(() => {
        const r = box.inbox(sent.thread_id);
        return r.ok ? r.status : r.error;
      })
      .toBe("working");
    const result = await box.send({
      thread_id: sent.thread_id,
      message: "nope",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error).toBe("thread is still working");
    box.stop(sent.thread_id);
  });
});

describe("log", () => {
  test("returns the actual structured agent output", async () => {
    const home = tempHome();
    const repo = join(home, "repo");
    initGitRepo(repo);
    const box = createMailbox(testCtx(home, repo));
    const sent = await box.send({
      repo: "demo",
      target: "fake",
      message: "write the file",
    });
    expect(sent.ok).toBe(true);
    if (!sent.ok) throw new Error(sent.error);
    await expect
      .poll(() => {
        const r = box.inbox(sent.thread_id);
        return r.ok ? r.status : r.error;
      })
      .toBe("succeeded");
    const log = box.log({ thread_id: sent.thread_id });
    expect(log.ok).toBe(true);
    if (!log.ok) throw new Error(log.error);
    expect(log.text).toBe('{"kind":"completed","message":"Task completed","sessionId":"fixture-session","findings":[]}');
  });

  test("unknown thread errors", () => {
    const home = tempHome();
    const repo = join(home, "repo");
    initGitRepo(repo);
    const box = createMailbox(testCtx(home, repo));
    expect(box.log({ thread_id: "nope" })).toEqual({
      ok: false,
      error: "thread_id must be 16 lowercase hex characters",
    });
    expect(box.log({ thread_id: "../../victim", run_id: "../../etc/passwd" })).toEqual({
      ok: false,
      error: "run_id must be a single storage id",
    });
  });

  test("returns at most 8 KiB even when a larger slice is requested", async () => {
    const home = tempHome();
    const repo = join(home, "repo");
    initGitRepo(repo);
    const box = createMailbox(testCtx(home, repo));
    const sent = await box.send({ repo: "demo", target: "fake", message: "write the file" });
    if (!sent.ok) throw new Error(sent.error);
    await expect.poll(() => {
      const result = box.inbox(sent.thread_id);
      return result.ok ? result.status : result.error;
    }).toBe("succeeded");
    writeFileSync(join(home, "threads", sent.thread_id, "runs", sent.run_id, "run.log"), "a".repeat(20_000));
    const log = box.log({ thread_id: sent.thread_id, limit: 100_000 });
    expect(log).toEqual({ ok: true, text: "a".repeat(8192) });
  });
});

describe("storage boundary", () => {
  test("a symlinked thread directory is not read", () => {
    const home = tempHome();
    const repo = join(home, "repo");
    initGitRepo(repo);
    const outside = mkdtempSync(join(tmpdir(), "outsrc-outside-"));
    const id = "0123456789abcdef";
    mkdirSync(join(home, "threads"));
    symlinkSync(outside, join(home, "threads", id));
    writeFileSync(join(outside, "secret.txt"), "SECRET-OUTSIDE");
    const box = createMailbox(testCtx(home, repo));
    expect(box.inbox(id)).toEqual({ ok: false, error: "path escapes storage" });
    expect(box.log({ thread_id: id })).toEqual({ ok: false, error: "path escapes storage" });
  });
});

describe("execution bounds", () => {
  test("refuses another job when the active limit is reached", async () => {
    const home = tempHome();
    const repo = join(home, "repo");
    initGitRepo(repo);
    const ctx = testCtx(home, repo, "sleep");
    const box = createMailbox({ ...ctx, config: { ...ctx.config, limits: { maxJobs: 1, maxRunMinutes: 120 } } });
    const first = await box.send({ repo: "demo", target: "fake", message: "sleep" });
    if (!first.ok) throw new Error(first.error);
    await expect.poll(() => {
      const result = box.inbox(first.thread_id);
      return result.ok ? result.status : result.error;
    }).toBe("working");
    const second = await box.send({ repo: "demo", target: "fake", message: "sleep again" });
    expect(second).toEqual({ ok: false, error: "active job limit reached (1); the owner can change it with outsrc config set limits.max_jobs <n>" });
    expect(box.stop(first.thread_id)).toEqual({ ok: true, stopped: true });
  });

  test("an unlimited job cap accepts more jobs than the default", async () => {
    const home = tempHome();
    const repo = join(home, "repo");
    initGitRepo(repo);
    const ctx = testCtx(home, repo, "sleep");
    const box = createMailbox({ ...ctx, config: { ...ctx.config, limits: { maxJobs: null, maxRunMinutes: null } } });
    const sent = [];
    for (let index = 0; index < 5; index++) sent.push(await box.send({ repo: "demo", target: "fake", message: `sleep ${index}` }));
    expect(sent.map((result) => result.ok)).toEqual([true, true, true, true, true]);
    for (const result of sent) if (result.ok) box.stop(result.thread_id);
  });

  test("does not signal a finished thread or a forged process group", async () => {
    const home = tempHome();
    const repo = join(home, "repo");
    initGitRepo(repo);
    const box = createMailbox(testCtx(home, repo));
    const sent = await box.send({ repo: "demo", target: "fake", message: "write the file" });
    if (!sent.ok) throw new Error(sent.error);
    await expect.poll(() => {
      const result = box.inbox(sent.thread_id);
      return result.ok ? result.status : result.error;
    }).toBe("succeeded");
    const kill = vi.spyOn(process, "kill");
    expect(box.stop(sent.thread_id)).toEqual({ ok: true, stopped: true });
    expect(box.inbox(sent.thread_id)).toMatchObject({ ok: true, status: "succeeded", message: "Task completed" });
    expect(kill.mock.calls.filter(([pid]) => typeof pid === "number" && pid < 0)).toEqual([]);
    kill.mockRestore();
  });

  test("does not signal a forged process group id", async () => {
    const home = tempHome();
    const repo = join(home, "repo");
    initGitRepo(repo);
    const box = createMailbox(testCtx(home, repo, "sleep"));
    const sent = await box.send({ repo: "demo", target: "fake", message: "sleep" });
    if (!sent.ok) throw new Error(sent.error);
    await expect.poll(() => {
      const result = box.inbox(sent.thread_id);
      return result.ok ? result.status : result.error;
    }).toBe("working");
    const file = join(home, "threads", sent.thread_id, "runs", sent.run_id, "process.json");
    const saved = JSON.parse(readFileSync(file, "utf8")) as { pgid: number };
    writeFileSync(file, JSON.stringify({ pid: 1, pgid: 1, startedAt: "bogus" }));
    const kill = vi.spyOn(process, "kill");
    expect(box.stop(sent.thread_id)).toEqual({
      ok: false,
      error: "refusing to signal a process that does not match the recorded wrapper",
    });
    expect(kill.mock.calls.filter(([pid]) => typeof pid === "number" && pid < 0)).toEqual([]);
    kill.mockRestore();
    try { process.kill(-saved.pgid, "SIGKILL"); } catch { /* wrapper already exited */ }
  });
});


