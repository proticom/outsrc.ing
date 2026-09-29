import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { appendHomeFile, ensureOutsrcHome, writeHomeFile } from "../src/fs-home.ts";

describe("outsrc home permissions", () => {
  test("creates the home as 0700 and writes files as 0600", () => {
    const home = join(tmpdir(), `outsrc-home-mode-${process.pid}-${Date.now()}`);
    rmSync(home, { recursive: true, force: true });
    ensureOutsrcHome(home);
    expect((statSync(home).mode & 0o777)).toBe(0o700);
    const file = join(home, "config.toml");
    writeHomeFile(file, "x = 1\n");
    expect((statSync(file).mode & 0o777)).toBe(0o600);
    appendHomeFile(join(home, "clients.jsonl"), "{}\n");
    expect((statSync(join(home, "clients.jsonl")).mode & 0o777)).toBe(0o600);
    expect(readFileSync(file, "utf8")).toBe("x = 1\n");
    rmSync(home, { recursive: true, force: true });
  });
});
