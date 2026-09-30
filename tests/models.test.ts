import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createMailbox } from "../src/mailbox.ts";
import { discoverModels, parseClaudeModels, parseCodexModels, parseGrokModels } from "../src/models.ts";
import type { TargetConfig } from "../src/types.ts";

const GROK_OUTPUT = "You are logged in with grok.com.\n\nDefault model: grok-4.7\n\nAvailable models:\n  * grok-4.7 (default)\n  - grok-4.7-build-fast\n  - grok-4.6\n";
const CODEX_OUTPUT = JSON.stringify({ models: [
  { slug: "gpt-b", visibility: "list", priority: 2 },
  { slug: "gpt-hidden", visibility: "hide", priority: 0 },
  { slug: "gpt-a", visibility: "list", priority: 1 },
] });
const CLAUDE_OUTPUT = [
  JSON.stringify({ type: "system", subtype: "init" }),
  JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "outsrc-models", response: { models: [
    { value: "default", resolvedModel: "claude-x-1" },
    { value: "opus", resolvedModel: "claude-opus-9" },
    { value: "claude-x-1", resolvedModel: "claude-x-1" },
  ] } } }),
].join("\n");

const scratch: string[] = [];
const originalPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = originalPath;
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A stand-in CLI that prints the given text and exits with the given code.
function fakeCli(name: string, stdout: string, exitCode = 0): string {
  const dir = mkdtempSync(join(tmpdir(), "outsrc-models-"));
  scratch.push(dir);
  const file = join(dir, name);
  writeFileSync(join(dir, "out.txt"), stdout);
  writeFileSync(file, `#!/bin/sh\ncat "${join(dir, "out.txt")}"\nexit ${exitCode}\n`);
  chmodSync(file, 0o755);
  return file;
}

describe("parsers", () => {
  test("Claude reads the initialize control response and keeps --model values", () => {
    expect(parseClaudeModels(CLAUDE_OUTPUT)).toEqual({ default: "claude-x-1", allowed: ["opus", "claude-x-1"] });
  });

  test("Codex keeps picker-visible models in priority order", () => {
    expect(parseCodexModels(CODEX_OUTPUT)).toEqual({ default: "gpt-a", allowed: ["gpt-a", "gpt-b"] });
  });

  test("Grok reads the models listing and its default marker", () => {
    expect(parseGrokModels(GROK_OUTPUT)).toEqual({ default: "grok-4.7", allowed: ["grok-4.7", "grok-4.7-build-fast", "grok-4.6"] });
  });

  test("unrecognized output lists nothing", () => {
    expect(parseClaudeModels("not json")).toBeNull();
    expect(parseCodexModels('{"models":[]}')).toBeNull();
    expect(parseGrokModels("Not logged in. Run grok login.")).toBeNull();
  });
});

describe("discoverModels", () => {
  test("runs the native CLI's listing command", () => {
    expect(discoverModels("grok", fakeCli("grok", GROK_OUTPUT))).toEqual({ default: "grok-4.7", allowed: ["grok-4.7", "grok-4.7-build-fast", "grok-4.6"] });
  });

  test("a plugin target asks the vendor CLI the engine runs, found on PATH", () => {
    const codex = fakeCli("codex", CODEX_OUTPUT);
    process.env.PATH = `${join(codex, "..")}:${originalPath}`;
    expect(discoverModels("codex-plugin", "/path/to/codex-companion.mjs")).toEqual({ default: "gpt-a", allowed: ["gpt-a", "gpt-b"] });
  });

  test("cannot list: custom adapter, failing CLI, missing CLI", () => {
    expect(discoverModels("custom", fakeCli("agent", GROK_OUTPUT))).toBeNull();
    expect(discoverModels("grok", fakeCli("grok", GROK_OUTPUT, 1))).toBeNull();
    expect(discoverModels("claude", join(tmpdir(), "outsrc-no-such-claude"))).toBeNull();
  });
});

describe("list_targets models", () => {
  function listed(targets: Record<string, TargetConfig>) {
    return createMailbox({ home: tmpdir(), config: { repos: [], targets } }).listTargets().targets
      .map(({ name, models, effort }) => ({ name, models, effort }));
  }

  test("configured models win, discovery fills the rest, custom stays null, effort is untouched", () => {
    const grok = fakeCli("grok", GROK_OUTPUT);
    const configured = { default: "grok-4.6", allowed: ["grok-4.6"] };
    const effort = { default: "high", allowed: ["low", "high"] };
    expect(listed({
      pinned: { adapter: "grok", command: grok, args: [], models: configured, effort },
      grok: { adapter: "grok", command: grok, args: [] },
      custom: { adapter: "custom", command: grok, args: [] },
    })).toEqual([
      { name: "pinned", models: configured, effort },
      { name: "grok", models: { default: "grok-4.7", allowed: ["grok-4.7", "grok-4.7-build-fast", "grok-4.6"] }, effort: null },
      { name: "custom", models: null, effort: null },
    ]);
  });
});
