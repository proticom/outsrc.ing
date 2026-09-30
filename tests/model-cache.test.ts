import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { Adapter } from "../src/adapters.ts";
import { createMailbox } from "../src/mailbox.ts";
import { modelCachePath, readModelCache } from "../src/model-cache.ts";
import type { ModelOptions } from "../src/models.ts";
import type { Config } from "../src/types.ts";
import { initGitRepo, tempHome, testCtx } from "./helpers.ts";

const project = fileURLToPath(new URL("..", import.meta.url));
const LISTED = { default: "grok-a", allowed: ["grok-a", "grok-b"] };
const AT = "2026-09-29T07:00:00.000Z";

function recordingDiscover(models: ModelOptions | null = LISTED) {
  const calls: string[] = [];
  const discover = (adapter: Adapter, command: string) => { calls.push(`${adapter} ${command}`); return models; };
  return { calls, discover };
}

function config(targets: Config["targets"]): Config {
  return { repos: [], targets };
}

function writeCache(home: string, targets: Record<string, unknown>) {
  writeFileSync(modelCachePath(home), JSON.stringify({ version: 1, targets }));
}

describe("list_targets reads the model cache", () => {
  test("a warm cache answers without discovery", () => {
    const home = tempHome();
    writeCache(home, { grok: { adapter: "grok", command: "grok", refreshedAt: AT, models: LISTED } });
    const { calls, discover } = recordingDiscover();
    const box = createMailbox({ home, config: config({ grok: { adapter: "grok", command: "grok", args: [] } }), discoverModels: discover });
    expect(box.listTargets().targets.map(({ name, models, models_refreshed_at }) => ({ name, models, models_refreshed_at })))
      .toEqual([{ name: "grok", models: LISTED, models_refreshed_at: AT }]);
    expect(calls).toEqual([]);
  });

  test("a miss discovers once, writes the cache, and later calls read it", () => {
    const home = tempHome();
    const { calls, discover } = recordingDiscover();
    const box = createMailbox({ home, config: config({ grok: { adapter: "grok", command: "grok", args: [] } }), discoverModels: discover });
    expect(box.listTargets().targets[0]?.models).toEqual(LISTED);
    expect(box.listTargets().targets[0]?.models).toEqual(LISTED);
    expect(calls).toEqual(["grok grok"]);
    expect(readModelCache(home).grok?.models).toEqual(LISTED);
  });

  test("configured models skip the cache; a changed command, a corrupt file or refresh rediscovers", () => {
    const home = tempHome();
    const configured = { default: "pinned", allowed: ["pinned"] };
    writeCache(home, { grok: { adapter: "grok", command: "/old/grok", refreshedAt: AT, models: LISTED } });
    const { calls, discover } = recordingDiscover({ default: "new", allowed: ["new"] });
    const targets = { grok: { adapter: "grok" as const, command: "grok", args: [] }, pinned: { adapter: "grok" as const, command: "grok", args: [], models: configured } };
    const box = createMailbox({ home, config: config(targets), discoverModels: discover });

    expect(box.listTargets().targets.map(({ name, models }) => ({ name, models })))
      .toEqual([{ name: "grok", models: { default: "new", allowed: ["new"] } }, { name: "pinned", models: configured }]);
    expect(calls).toEqual(["grok grok"]);

    box.listTargets({ refresh: true });
    expect(calls).toEqual(["grok grok", "grok grok"]);

    writeFileSync(modelCachePath(home), "{not json");
    box.listTargets();
    expect(calls).toEqual(["grok grok", "grok grok", "grok grok"]);
  });

  test("refreshModels rediscovers one named target and rejects unknown names", () => {
    const home = tempHome();
    writeCache(home, {
      a: { adapter: "grok", command: "grok", refreshedAt: AT, models: LISTED },
      b: { adapter: "codex", command: "codex", refreshedAt: AT, models: LISTED },
    });
    const { calls, discover } = recordingDiscover();
    const box = createMailbox({ home, config: config({ a: { adapter: "grok", command: "grok", args: [] }, b: { adapter: "codex", command: "codex", args: [] } }), discoverModels: discover });
    expect(Object.keys(box.refreshModels("b").refreshed)).toEqual(["b"]);
    expect(calls).toEqual(["codex codex"]);
    expect(readModelCache(home).a?.refreshedAt).toBe(AT);
    expect(() => box.refreshModels("missing")).toThrow("unknown target: missing");
  });
});

describe("send checks --model against the cached list", () => {
  function sendBox(models: ModelOptions | null) {
    const home = tempHome();
    const repo = join(home, "repo");
    initGitRepo(repo);
    return createMailbox({ ...testCtx(home, repo), discoverModels: recordingDiscover(models).discover });
  }

  test("an unknown model fails and names the cached models", async () => {
    const result = await sendBox(LISTED).send({ repo: "demo", target: "fake", message: "do it", model: "grok-made-up" });
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/^model not allowed: grok-made-up\. Allowed for fake: grok-a, grok-b \(cached .+; run outsrc models refresh if the list is out of date\)$/) });
  });

  test("a cached model is accepted", async () => {
    const result = await sendBox(LISTED).send({ repo: "demo", target: "fake", message: "do it", model: "grok-b" });
    expect(result).toMatchObject({ ok: true });
  });

  test("with no listable models the vendor CLI decides", async () => {
    const result = await sendBox(null).send({ repo: "demo", target: "fake", message: "do it", model: "anything" });
    expect(result).toMatchObject({ ok: true });
  });
});

describe("CLI", () => {
  function outsrc(home: string, ...args: string[]) {
    const env: NodeJS.ProcessEnv = { ...process.env, OUTSRC_HOME: home };
    delete env.OUTSRC_JOB;
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { cwd: project, env, encoding: "utf8" });
    return { status: result.status, json: JSON.parse(result.stdout) as Record<string, unknown>, stderr: result.stderr };
  }

  // A grok stand-in that records each run, so a test can prove the hot path never spawned it.
  function setup() {
    const home = tempHome();
    const grok = join(home, "grok");
    const marker = join(home, "grok-ran");
    writeFileSync(grok, `#!/bin/sh\necho x >> "${marker}"\nprintf 'Available models:\\n  * grok-a (default)\\n  - grok-b\\n'\n`);
    chmodSync(grok, 0o755);
    writeFileSync(join(home, "config.toml"), `[targets.grok]\nadapter = "grok"\ncommand = ${JSON.stringify(grok)}\n`);
    return { home, grok, marker };
  }

  test("models refresh writes the cache; list_targets then reads it without running grok; --refresh runs it", () => {
    const { home, grok, marker } = setup();
    const refreshed = outsrc(home, "models", "refresh");
    expect(refreshed.status).toBe(0);
    expect(refreshed.json).toMatchObject({ path: modelCachePath(home), refreshed: { grok: { adapter: "grok", command: grok, models: LISTED } } });
    expect(readFileSync(marker, "utf8")).toBe("x\n");

    const listed = outsrc(home, "list_targets");
    expect((listed.json.targets as { models: unknown }[])[0]?.models).toEqual(LISTED);
    expect(readFileSync(marker, "utf8")).toBe("x\n");

    outsrc(home, "list_targets", "--refresh");
    expect(readFileSync(marker, "utf8")).toBe("x\nx\n");

    expect(outsrc(home, "models").json).toMatchObject({ targets: { grok: { models: LISTED } } });
  });

  test("first list_targets on an empty cache discovers once and writes the cache", () => {
    const { home, marker } = setup();
    expect(existsSync(modelCachePath(home))).toBe(false);
    outsrc(home, "list_targets");
    outsrc(home, "list_targets");
    expect(readFileSync(marker, "utf8")).toBe("x\n");
    expect(readModelCache(home).grok?.models).toEqual(LISTED);
  });
});
