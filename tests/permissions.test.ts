import { describe, expect, test } from "vitest";
import { permissionFlags } from "../src/permissions.ts";

describe("permissionFlags", () => {
  test("auto adds Claude bypass", () => {
    expect(permissionFlags("/usr/bin/claude", ["-p"], "auto")).toEqual([
      "--permission-mode",
      "bypassPermissions",
    ]);
  });

  test("auto adds Codex approve-for-me", () => {
    expect(permissionFlags("codex", ["exec"], "auto")).toEqual([
      "--approve-for-me",
    ]);
  });

  test("auto adds Grok always-approve", () => {
    expect(permissionFlags("grok", ["-p"], "auto")).toEqual([
      "--always-approve",
    ]);
  });

  test("auto skips flags already present", () => {
    expect(
      permissionFlags("grok", ["--always-approve", "-p"], "auto"),
    ).toEqual([]);
  });

  test("ask adds nothing", () => {
    expect(permissionFlags("claude", ["-p"], "ask")).toEqual([]);
    expect(permissionFlags("codex", ["exec"], "ask")).toEqual([]);
  });

  test("fake target is unchanged", () => {
    expect(permissionFlags("/usr/bin/node", ["fake-cli.mjs"], "auto")).toEqual(
      [],
    );
  });
});
