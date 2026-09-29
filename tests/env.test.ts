import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createMailbox } from "../src/mailbox.ts";
import { initGitRepo, tempHome, testCtx } from "./helpers.ts";

describe("job env", () => {
  test("drops AWS and GitHub tokens from the CLI", async () => {
    const home = tempHome();
    const repo = join(home, "repo");
    initGitRepo(repo);
    const prevAws = process.env.AWS_SECRET_ACCESS_KEY;
    const prevGh = process.env.GITHUB_TOKEN;
    process.env.AWS_SECRET_ACCESS_KEY = "should-not-leak";
    process.env.GITHUB_TOKEN = "should-not-leak";
    try {
      const ctx = testCtx(home, repo, "dumpenv");
      const box = createMailbox(ctx);
      const sent = await box.send({
        repo: "demo",
        target: "fake",
        message: "dump env",
      });
      expect(sent.ok).toBe(true);
      if (!sent.ok) throw new Error(sent.error);
      await expect
        .poll(() => {
          const r = box.inbox(sent.thread_id);
          return r.ok ? r.status : r.error;
        })
        .toBe("succeeded");
      const keys = readFileSync(
        join(home, "worktrees", "demo", sent.thread_id, "env-keys.txt"),
        "utf8",
      );
      expect(keys).not.toMatch(/AWS_SECRET_ACCESS_KEY/);
      expect(keys).not.toMatch(/GITHUB_TOKEN/);
      expect(keys).toMatch(/^PATH$/m);
      expect(keys).toMatch(/^OUTSRC_JOB$/m);
    } finally {
      if (prevAws === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
      else process.env.AWS_SECRET_ACCESS_KEY = prevAws;
      if (prevGh === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = prevGh;
    }
  });
});
