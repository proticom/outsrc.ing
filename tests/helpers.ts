import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config, MailboxContext } from "../src/types.ts";

const here = dirname(fileURLToPath(import.meta.url));

export const FAKE_AGENT = join(here, "fixtures", "fake-agent.mjs");
type FakeMode = "task" | "sleep" | "question" | "fail" | "dumpenv";

export function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "outsrc-home-"));
}

export function initGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "test@example.com"', { cwd: dir });
  execSync('git config user.name "test"', { cwd: dir });
  writeFileSync(join(dir, "README.md"), "fixture\n");
  execSync("git add README.md && git commit -m init", {
    cwd: dir,
    stdio: "ignore",
  });
}

export function testConfig(repoPath: string, mode: FakeMode = "task"): Config {
  return {
    repos: [{ alias: "demo", path: repoPath }],
    targets: {
      fake: {
        adapter: "custom",
        command: process.execPath,
        args: [FAKE_AGENT, mode, "--session", "{session_id}"],
      },
    },
  };
}

export function testCtx(home: string, repoPath: string, mode: FakeMode = "task"): MailboxContext {
  return {
    home,
    config: testConfig(repoPath, mode),
    retryAfterSeconds: 1,
    nodeExecutable: process.execPath,
  };
}
