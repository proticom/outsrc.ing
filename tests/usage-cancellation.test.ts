import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createMailbox } from "../src/mailbox.ts";
import { initGitRepo, tempHome } from "./helpers.ts";

test("send then stop retains vendor tokens in cancelled inbox, history and usage", async () => {
  const home = tempHome();
  const repo = join(home, "repo");
  initGitRepo(repo);
  const script = join(home, "vendor.mjs");
  writeFileSync(script, 'process.stdout.write(JSON.stringify({usage:{input_tokens:17,output_tokens:4},model:"reported-model"}));setInterval(()=>{},1000);');
  const box = createMailbox({ home, config: { repos: [{ alias: "demo", path: repo }],
    targets: { native: { adapter: "claude", command: process.execPath, args: [script] } } } });
  const sent = await box.send({ repo: "demo", target: "native", message: "usage smoke", model: "requested-model", effort: "low" });
  if (!sent.ok) throw new Error(sent.error);
  try {
    const file = join(home, "threads", sent.thread_id, "runs", sent.run_id, "usage.json");
    await expect.poll(() => existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null,
      { timeout: 5000 }).toMatchObject({ tokens_in: 17, tokens_out: 4, model: "reported-model", effort: "low" });
    expect(box.stop(sent.thread_id)).toEqual({ ok: true, stopped: true });
    const fields = { target: "native", model: "reported-model", effort: "low",
      usage: { tokens_in: 17, tokens_out: 4, estimated_cost_usd: null } };
    expect(box.inbox(sent.thread_id)).toMatchObject({ ok: true, status: "cancelled", ...fields });
    expect(box.history(sent.thread_id)).toMatchObject({ ok: true, runs: [{ status: "cancelled", ...fields }] });
    expect(box.usage()).toMatchObject({ ok: true, today: { runs: 1, tokens_in: { total: 17, missing_runs: 0 },
      tokens_out: { total: 4, missing_runs: 0 } } });
  } finally {
    box.stop(sent.thread_id);
    rmSync(home, { recursive: true, force: true });
  }
});
