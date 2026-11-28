import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { configFromDocument, ConfigSchema, loadConfigFile } from "../src/config.ts";

describe("loadConfigFile", () => {
  test("worktree command accepts only git or git-cow and leaves old config unchanged", () => {
    expect(configFromDocument({}, "/tmp/config.toml")).toEqual({ repos: [], targets: {}, limits: { maxJobs: 4, maxRunMinutes: 120 } });
    expect(ConfigSchema.parse({ worktree: {} }).worktree).toEqual({ command: "git" });
    for (const command of ["git", "git-cow"]) {
      expect(configFromDocument({ worktree: { command } }, "/tmp/config.toml").worktree).toEqual({ command });
    }
    expect(() => ConfigSchema.parse({ worktree: { command: "svn" } })).toThrow();
  });
  test("reads repos and targets", () => {
    const dir = join(tmpdir(), `outsrc-cfg-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "config.toml");
    writeFileSync(
      file,
      `
[[repos]]
alias = "outsrc.ing"
path = "/tmp/outsrc.ing"

[targets.fake]
command = "/tmp/fake-cli.mjs"
args = ["--write", "ok.txt"]
`.trimStart(),
    );
    const cfg = loadConfigFile(file);
    expect(cfg.repos).toEqual([
      { alias: "outsrc.ing", path: "/tmp/outsrc.ing" },
    ]);
    expect(cfg.targets.fake).toEqual({
      command: "/tmp/fake-cli.mjs",
      args: ["--write", "ok.txt"],
    });
  });

  test("reads permissions ask", () => {
    const dir = join(tmpdir(), `outsrc-cfg-${Date.now()}-ask`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "config.toml");
    writeFileSync(
      file,
      `
[[repos]]
alias = "demo"
path = "/tmp/demo"

[targets.claude]
command = "claude"
args = ["-p"]
permissions = "ask"
`.trimStart(),
    );
    const cfg = loadConfigFile(file);
    expect(cfg.targets.claude?.permissions).toBe("ask");
  });

  test("throws on missing file", () => {
    expect(() => loadConfigFile("/tmp/does-not-exist-outsrc.toml")).toThrow(
      /config/,
    );
  });
});
