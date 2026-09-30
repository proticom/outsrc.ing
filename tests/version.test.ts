import { expect, test } from "vitest";
import { compareVersions, isBehind, parseVersion } from "../src/version.ts";

test("parseVersion reads the version out of each CLI's --version line", () => {
  expect(parseVersion("2.1.285 (Claude Code)")?.text).toBe("2.1.285");
  expect(parseVersion("codex-cli 0.159.2\n")?.text).toBe("0.159.2");
  expect(parseVersion("grok 1.0.44 (5b807183dd79) [stable]")?.text).toBe("1.0.44");
  expect(parseVersion("grok 0.1.151-alpha.2")?.prerelease).toEqual(["alpha", "2"]);
  expect(parseVersion("command not found")).toBeNull();
});

test("isBehind compares numerically, not as text", () => {
  expect(isBehind("2.1.9", "2.1.10")).toBe(true);
  expect(isBehind("2.1.10", "2.1.9")).toBe(false);
  expect(isBehind("0.159.2", "0.159.2")).toBe(false);
  expect(isBehind("1.9.0", "2.0.0")).toBe(true);
  expect(isBehind("unknown", "2.0.0")).toBe(false);
});

test("a release is newer than its prereleases, and prerelease fields compare by semver rules", () => {
  const order = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
  for (let i = 1; i < order.length; i += 1) {
    expect(compareVersions(parseVersion(order[i - 1]!)!, parseVersion(order[i]!)!)).toBeLessThan(0);
    expect(compareVersions(parseVersion(order[i]!)!, parseVersion(order[i - 1]!)!)).toBeGreaterThan(0);
  }
});
