import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { loadConfigFile } from "../src/config.ts";
import { installEngine, managedScript, readLock, resolveCommit, writeLockEntry, type LockEntry } from "../src/engines.ts";

const fixture = fileURLToPath(new URL("./fixtures/fake-plugin/", import.meta.url));

function upstream() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "outsrc-upstream-")));
  const source = join(root, "codex-plugin-cc");
  mkdirSync(join(source, "plugins"), { recursive: true });
  cpSync(fixture, join(source, "plugins", "codex"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "plugin");
  const commit = git("rev-parse", "HEAD");
  const entry: LockEntry = { source: `file://${source}`, path: "plugins/codex", version: "9.9.9", commit };
  return { source, entry, home: realpathSync(mkdtempSync(join(tmpdir(), "outsrc-home-"))) };
}

describe("pinned plugin engines", () => {
  test("install fetches exactly the pinned commit into the outsrc home, and a rerun needs no network", () => {
    const { source, entry, home } = upstream();
    const script = installEngine(home, "codex-plugin", entry);
    expect(script).toBe(join(home, "engines", "codex-plugin", entry.commit, "scripts", "codex-companion.mjs"));
    expect(readFileSync(join(home, "engines", "codex-plugin", entry.commit, ".claude-plugin", "plugin.json"), "utf8")).toContain('"9.9.9"');
    rmSync(source, { recursive: true });
    expect(installEngine(home, "codex-plugin", entry)).toBe(script);
    expect(managedScript(home, "codex-plugin", { "codex-plugin": entry })).toBe(script);
    expect(managedScript(home, "codex-plugin", { "codex-plugin": { ...entry, commit: "0".repeat(40) } })).toBeNull();
  });

  test("a pin whose commit lacks the plugin folder fails and leaves nothing behind", () => {
    const { entry, home } = upstream();
    expect(() => installEngine(home, "codex-plugin", { ...entry, path: "plugins/missing" }))
      .toThrow(`has no plugins/missing/scripts/codex-companion.mjs`);
    expect(existsSync(join(home, "engines", "codex-plugin", entry.commit))).toBe(false);
  });

  test("a branch resolves to its commit, and the lock round-trips", () => {
    const { entry } = upstream();
    expect(resolveCommit(entry.source, "main")).toBe(entry.commit);
    expect(resolveCommit(entry.source, entry.commit)).toBe(entry.commit);
    const file = join(mkdtempSync(join(tmpdir(), "outsrc-lock-")), "engines.lock.json");
    writeLockEntry("codex-plugin", entry, file);
    expect(readLock(file)).toEqual({ "codex-plugin": entry });
  });

  test("a plugin target without a command resolves to the pinned engine in its home", () => {
    const { entry, home } = upstream();
    const script = installEngine(home, "codex-plugin", entry);
    writeFileSync(join(home, "config.toml"), '[targets.codex]\nadapter = "codex-plugin"\n');
    const lock = readLock();
    // The repository lock pins the real plugin, so point this home's engine folder at that commit.
    cpSync(join(home, "engines", "codex-plugin", entry.commit), join(home, "engines", "codex-plugin", lock["codex-plugin"]?.commit ?? ""), { recursive: true });
    expect(loadConfigFile(join(home, "config.toml")).targets.codex?.command)
      .toBe(script.replace(entry.commit, lock["codex-plugin"]?.commit ?? ""));
  });
});
