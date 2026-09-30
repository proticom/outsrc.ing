import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { aggregateUsage, readAdapterUsage } from "../src/usage.ts";
import { ResultSchema } from "../src/state.ts";
import type { Adapter } from "../src/adapters.ts";

const unknownUsage = { tokens_in: null, tokens_out: null, estimated_cost_usd: null, wall_minutes: null, model: null, effort: null };

describe("vendor usage boundary", () => {
  test("reads the saved Grok envelope once despite its repeated copies", () => {
    const stdout = readFileSync(new URL("./fixtures/plugin-grok-critique.json", import.meta.url), "utf8");
    expect(readAdapterUsage({ adapter: "grok-plugin", stdout })).toEqual({
      tokens_in: 30655, tokens_out: 369, estimated_cost_usd: 0.021794, wall_minutes: null, model: "grok-4.7-build", effort: null,
    });
  });
  test("reads vendor stdout when the plugin's parsed review has no metadata", () => {
    expect(readAdapterUsage({ adapter: "grok-plugin", stdout: JSON.stringify({
      result: { verdict: "ok", summary: "review", findings: [] },
      grok: { stdout: JSON.stringify({ usage: { input_tokens: 12, output_tokens: 3 }, total_cost_usd: 0.01 }) },
    }) })).toEqual({ ...unknownUsage, tokens_in: 12, tokens_out: 3, estimated_cost_usd: 0.01 });
  });
  test("coalesces partial duplicate metadata without adding it", () => {
    expect(readAdapterUsage({ adapter: "grok-plugin", stdout: JSON.stringify({
      result: { usage: { input_tokens: 12 }, model: "primary-model" },
      grok: { stdout: JSON.stringify({ usage: { input_tokens: 12, output_tokens: 3 }, total_cost_usd: 0.01 }) },
    }) })).toEqual({ ...unknownUsage, tokens_in: 12, tokens_out: 3, estimated_cost_usd: 0.01, model: "primary-model" });
  });

  test.each(["claude", "grok"] satisfies Adapter[])("reads %s metadata outside the structured answer", (adapter) => {
    const stdout = JSON.stringify({ type: "result", usage: { input_tokens: 120, output_tokens: 8 }, total_cost_usd: 0.04,
      modelUsage: { "observed-model": {} }, structured_output: { usage: { input_tokens: 999999 } } });
    expect(readAdapterUsage({ adapter, stdout })).toEqual({
      tokens_in: 120, tokens_out: 8, estimated_cost_usd: 0.04, wall_minutes: null, model: "observed-model", effort: null,
    });
  });

  test("reads the final envelope in a native result array", () => {
    const stdout = JSON.stringify([{ type: "assistant", model: "early-model" },
      { type: "result", usage: { input_tokens: 0, output_tokens: 4 }, total_cost_usd: 0 }]);
    expect(readAdapterUsage({ adapter: "claude", stdout })).toEqual({
      tokens_in: 0, tokens_out: 4, estimated_cost_usd: 0, wall_minutes: null, model: null, effort: null,
    });
  });

  test("sums completed Codex turns without using cached tokens or guessing a cost or model", () => {
    const stdout = [{ type: "thread.started", thread_id: "example" },
      { type: "turn.completed", usage: { input_tokens: 12, output_tokens: 3, cached_input_tokens: 7 } },
      { type: "turn.completed", usage: { input_tokens: 8, output_tokens: 2 } }].map((event) => JSON.stringify(event)).join("\n");
    expect(readAdapterUsage({ adapter: "codex", stdout })).toEqual({
      tokens_in: 20, tokens_out: 5, estimated_cost_usd: null, wall_minutes: null, model: null, effort: null,
    });
    expect(readAdapterUsage({ adapter: "codex", stdout: `${stdout}\n{"type":"turn.completed"}` })).toEqual(unknownUsage);
  });

  test("preserves available fields while rejecting invalid numbers and ambiguous models", () => {
    expect(readAdapterUsage({ adapter: "grok", stdout: JSON.stringify({
      usage: { input_tokens: -2, output_tokens: 3 }, total_cost_usd: "0.01", modelUsage: { a: {}, b: {} },
    }) })).toEqual({ ...unknownUsage, tokens_out: 3 });
    expect(readAdapterUsage({ adapter: "grok", stdout: '{"modelUsage":{"":{}}}' })).toEqual(unknownUsage);
    expect(readAdapterUsage({ adapter: "grok", stdout: '{"usage":null,"total_cost_usd":0.01}' })).toEqual({ ...unknownUsage, estimated_cost_usd: 0.01 });
  });

  test.each(["custom", "codex-plugin"] satisfies Adapter[])("%s does not interpret model answer text as usage", (adapter) => {
    expect(readAdapterUsage({ adapter, stdout: JSON.stringify({ usage: { input_tokens: 100, output_tokens: 3 }, total_cost_usd: 2 }) })).toEqual(unknownUsage);
  });

  test.each(["plugin-codex-review.json", "plugin-grok-task.json", "plugin-codex-task.json"])("missing metadata in %s stays null", (fixture) => {
    const adapter = fixture.startsWith("plugin-grok") ? "grok-plugin" : "codex-plugin";
    expect(readAdapterUsage({ adapter, stdout: readFileSync(new URL(`./fixtures/${fixture}`, import.meta.url), "utf8") })).toEqual(unknownUsage);
  });

  test("invalid output has explicit nulls", () => {
    expect(readAdapterUsage({ adapter: "grok", stdout: "not JSON" })).toEqual(unknownUsage);
  });

  test("retains completed Codex usage after a truncated trailing event", () => {
    const stdout = '{"type":"turn.completed","usage":{"input_tokens":25,"output_tokens":6}}\n{"type":"turn.failed"';
    expect(readAdapterUsage({ adapter: "codex", stdout })).toEqual({ ...unknownUsage, tokens_in: 25, tokens_out: 6 });
  });

  test("old result records gain explicit nulls without a migration", () => {
    const parsed = ResultSchema.parse({ kind: "completed", message: "old", sessionId: null, findings: [], exitCode: 0,
      finishedAt: "2026-09-29T00:00:00Z", diffstat: "", commit: null });
    expect(parsed.usage).toEqual(unknownUsage);
  });
});

describe("local usage totals", () => {
  test("labels local midnight and the preceding 168 hours with their actual boundaries", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    try {
      expect(aggregateUsage([], new Date("2026-09-29T19:00:00Z"))).toMatchObject({
        as_of: "2026-09-29T19:00:00.000Z",
        today: { since: "2026-09-29T07:00:00.000Z" },
        last_7_days: { since: "2026-09-22T19:00:00.000Z" },
      });
    } finally { vi.unstubAllEnvs(); }
  });

  test("counts runs once, filters windows, and exposes incomplete totals per target", () => {
    const now = new Date(2026, 8, 29, 12);
    const today = new Date(2026, 8, 29, 10).toISOString();
    const yesterday = new Date(2026, 8, 28, 10).toISOString();
    const report = aggregateUsage([
      { target: "grok", created_at: today, usage: { tokens_in: 20, tokens_out: 4, estimated_cost_usd: 0.03, wall_minutes: 2, model: "grok-model", effort: null } },
      { target: "codex", created_at: yesterday, usage: { ...unknownUsage, tokens_in: 100, tokens_out: 8, wall_minutes: 3 } },
      { target: "codex", created_at: today, usage: unknownUsage },
      { target: "old", created_at: new Date(2026, 8, 20, 10).toISOString(), usage: unknownUsage },
      { target: "future", created_at: new Date(2026, 8, 30, 10).toISOString(), usage: unknownUsage },
    ], now);
    expect(report.today).toMatchObject({ runs: 2,
      tokens_in: { total: null, missing_runs: 1 }, estimated_cost_usd: { total: null, missing_runs: 1 },
      by_target: [
        { target: "codex", runs: 1, tokens_in: { total: null, missing_runs: 1 } },
        { target: "grok", runs: 1, tokens_in: { total: 20, missing_runs: 0 }, tokens_out: { total: 4, missing_runs: 0 },
          estimated_cost_usd: { total: 0.03, missing_runs: 0 }, wall_minutes: { total: 2, missing_runs: 0 } },
      ],
    });
    expect(report.last_7_days).toMatchObject({ runs: 3, tokens_in: { total: null, missing_runs: 1 },
      estimated_cost_usd: { total: null, missing_runs: 2 }, by_target: [
        { target: "codex", runs: 2 }, { target: "grok", runs: 1 },
      ] });
  });

  test("empty windows have measured zero runs and zero totals", () => {
    expect(aggregateUsage([], new Date("2026-09-29T12:00:00Z")).today).toMatchObject({ runs: 0, by_target: [],
      tokens_in: { total: 0, missing_runs: 0 }, tokens_out: { total: 0, missing_runs: 0 },
      estimated_cost_usd: { total: 0, missing_runs: 0 }, wall_minutes: { total: 0, missing_runs: 0 },
    });
  });
});
