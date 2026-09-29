import { describe, expect, test } from "vitest";
import { parseRunId, parseTargetName, parseThreadId } from "../src/types.ts";

describe("parseThreadId", () => {
  test("accepts a minted id", () => {
    expect(parseThreadId("0123456789abcdef")).toBe("0123456789abcdef");
  });

  test("rejects empty, short, and traversal ids", () => {
    expect(() => parseThreadId("")).toThrow("thread_id must be 16 lowercase hex characters");
    expect(() => parseThreadId("01jabc")).toThrow("thread_id must be 16 lowercase hex characters");
    expect(() => parseThreadId("../../victim")).toThrow("thread_id must be 16 lowercase hex characters");
    expect(() => parseThreadId("0123456789ABCDEF")).toThrow("thread_id must be 16 lowercase hex characters");
  });
});

describe("parseRunId", () => {
  test("accepts a storage segment and rejects a path", () => {
    expect(parseRunId("legacy")).toBe("legacy");
    expect(parseRunId("0123456789abcdef")).toBe("0123456789abcdef");
    expect(() => parseRunId("../../victim")).toThrow("run_id must be a single storage id");
    expect(() => parseRunId("a/b")).toThrow("run_id must be a single storage id");
  });
});

describe("parseTargetName", () => {
  test("accepts a config key", () => {
    expect(parseTargetName("codex")).toBe("codex");
  });

  test("rejects empty", () => {
    expect(() => parseTargetName("  ")).toThrow(/target/);
  });
});
