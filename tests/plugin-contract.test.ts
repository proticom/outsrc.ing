import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { loadConfigFile } from "../src/config.ts";
import { writeLockEntry } from "../src/engines.ts";
import { checkPluginContract } from "../src/plugin-contract.ts";

const fixture = fileURLToPath(new URL("./fixtures/fake-plugin/", import.meta.url));

function copy() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "outsrc-plugin-copy-")));
  cpSync(fixture, root, { recursive: true });
  const verified = join(root, "engines.lock.json");
  writeFileSync(verified, "{}");
  return { root, script: join(root, "scripts", "codex-companion.mjs"), verified };
}

describe("plugin contract check", () => {
  test("a compatible engine is unverified until the lock pins its version", () => {
    const { script, verified } = copy();
    expect(checkPluginContract("codex-plugin", script, verified)).toEqual({ adapter: "codex-plugin", script, version: "9.9.9", status: "unverified", problems: [] });
    writeLockEntry("codex-plugin", { source: "https://example.test/p.git", path: "plugins/codex", version: "9.9.9", commit: "a".repeat(40) }, verified);
    expect(checkPluginContract("codex-plugin", script, verified).status).toBe("ok");
  });

  test("removed flags, renamed session variables and a missing teardown hook are reported as broken", () => {
    const { root, script, verified } = copy();
    writeFileSync(script, readFileSync(script, "utf8").replace("[--resume-last|--resume|--fresh]", "[--continue|--fresh]").replaceAll("CODEX_COMPANION_SESSION_ID", "CODEX_SESSION"));
    rmSync(join(root, "scripts", "session-lifecycle-hook.mjs"));
    expect(checkPluginContract("codex-plugin", script, verified)).toMatchObject({
      status: "broken",
      problems: [
        "task no longer lists --resume-last",
        "engine source no longer mentions CODEX_COMPANION_SESSION_ID",
        "teardown hook missing or no longer handles SessionEnd: scripts/session-lifecycle-hook.mjs",
      ],
    });
  });

  test("a status command that stops returning JSON for --cwd is reported", () => {
    const { script, verified } = copy();
    writeFileSync(script, readFileSync(script, "utf8").replace("JSON.stringify({ workspaceRoot: args[args.indexOf(\"--cwd\") + 1], jobs: [] })", "\"no json\""));
    expect(checkPluginContract("codex-plugin", script, verified).problems).toEqual(["status --json --cwd did not return the expected JSON (exit 0)"]);
  });

  test("a symlinked engine path is resolved, because grok-bridge.mjs exits silently when argv[1] is not its real path", () => {
    const { root, script, verified } = copy();
    const link = join(mkdtempSync(join(tmpdir(), "outsrc-plugin-link-")), "plugin");
    symlinkSync(root, link);
    const linked = join(link, "scripts", "codex-companion.mjs");
    expect(checkPluginContract("codex-plugin", linked, verified).script).toBe(realpathSync(script));
    const home = mkdtempSync(join(tmpdir(), "outsrc-config-"));
    writeFileSync(join(home, "config.toml"), `[targets.codex]\nadapter = "codex-plugin"\ncommand = ${JSON.stringify(linked)}\n`);
    expect(loadConfigFile(join(home, "config.toml")).targets.codex?.command).toBe(realpathSync(script));
  });

  test("a missing engine script is broken", () => {
    expect(checkPluginContract("grok-plugin", "/nonexistent/scripts/grok-bridge.mjs")).toEqual({
      adapter: "grok-plugin", script: "/nonexistent/scripts/grok-bridge.mjs", version: null, status: "broken",
      problems: ["engine script not found: /nonexistent/scripts/grok-bridge.mjs"],
    });
  });
});
