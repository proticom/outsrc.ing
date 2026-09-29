import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { resolveInside, threadDir } from "../src/paths.ts";
import { parseThreadId } from "../src/types.ts";
import { tempHome } from "./helpers.ts";

describe("resolveInside", () => {
  test("rejects a symlink that leaves the mailbox home", () => {
    const home = tempHome();
    const outside = mkdtempSync(join(tmpdir(), "outsrc-outside-"));
    writeFileSync(join(outside, "secret.txt"), "SECRET-OUTSIDE");
    mkdirSync(join(home, "threads"));
    symlinkSync(outside, join(home, "threads", "0123456789abcdef"));
    expect(() => threadDir(home, parseThreadId("0123456789abcdef"))).toThrow("path escapes storage");
    expect(() => resolveInside(home, "..", "etc")).toThrow("path escapes storage");
  });
});
