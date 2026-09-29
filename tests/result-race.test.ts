import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { writeJson } from "../src/state.ts";
import { initGitRepo, tempHome, testCtx } from "./helpers.ts";

// When set, the next liveness check behaves as a wrapper that published its result and exited just before it was observed.
const race = vi.hoisted(() => ({ runDir: null as string | null }));
vi.mock("../src/job.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/job.ts")>();
  return {
    ...actual,
    processIdentity: (record: Parameters<typeof actual.processIdentity>[0]) => {
      if (!race.runDir) return actual.processIdentity(record);
      writeJson(join(race.runDir, "result.json"), {
        kind: "completed", message: "Published while exiting", sessionId: "fixture-session", findings: [],
        exitCode: 0, finishedAt: new Date().toISOString(), diffstat: "", commit: null,
      });
      race.runDir = null;
      return "mismatch" as const;
    },
  };
});

const { createMailbox } = await import("../src/mailbox.ts");

test("a result published as the wrapper exits is kept, not overwritten with a wrapper failure", async () => {
  const home = tempHome();
  const repo = join(home, "repo");
  initGitRepo(repo);
  const box = createMailbox(testCtx(home, repo, "sleep"));
  const sent = await box.send({ repo: "demo", target: "fake", message: "sleep" });
  if (!sent.ok) throw new Error(sent.error);
  const runDir = join(home, "threads", sent.thread_id, "runs", sent.run_id);
  await expect.poll(() => existsSync(join(runDir, "process.json"))).toBe(true);

  race.runDir = runDir;
  expect(box.inbox(sent.thread_id)).toMatchObject({ status: "succeeded", message: "Published while exiting", session_id: "fixture-session" });
  box.stop(sent.thread_id);
});
