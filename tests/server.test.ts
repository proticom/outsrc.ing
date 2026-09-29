import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createMailbox } from "../src/mailbox.ts";
import { handleTool } from "../src/server.ts";
import { initGitRepo, tempHome, testCtx } from "./helpers.ts";

describe("handleTool", () => {
  test("list_repos returns aliases", async () => {
    const home = tempHome();
    const repo = join(home, "repo");
    initGitRepo(repo);
    const box = createMailbox(testCtx(home, repo));
    const out = await handleTool(box, "list_repos", {});
    expect(out.isError).toBeUndefined();
    expect(JSON.parse(out.content[0]!.text)).toEqual({
      repos: [{ alias: "demo", path: repo }],
    });
  });

  test("send unknown repo is an error payload", async () => {
    const home = tempHome();
    const repo = join(home, "repo");
    initGitRepo(repo);
    const box = createMailbox(testCtx(home, repo));
    const out = await handleTool(box, "send", {
      repo: "nope",
      target: "fake",
      message: "x",
    });
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toMatch(/unknown repo/);
  });

  test("send passes thread_id for a follow-up", async () => {
    const home = tempHome();
    const repo = join(home, "repo");
    initGitRepo(repo);
    const box = createMailbox(testCtx(home, repo));
    const out = await handleTool(box, "send", {
      thread_id: "nope",
      message: "yes",
    });
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toMatch(/16 lowercase hex/);
  });
});
