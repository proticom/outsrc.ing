import { z } from "zod";
import type { Adapter } from "./adapters.js";

const Tokens = z.number().int().nonnegative();
const Amount = z.number().nonnegative();
export const RunUsageSchema = z.object({
  tokens_in: Tokens.nullable(),
  tokens_out: Tokens.nullable(),
  estimated_cost_usd: Amount.nullable(),
  wall_minutes: Amount.nullable(),
  model: z.string().min(1).nullable(),
  effort: z.string().nullable(),
});
export type RunUsage = z.infer<typeof RunUsageSchema>;
export function emptyUsage(): RunUsage {
  return { tokens_in: null, tokens_out: null, estimated_cost_usd: null, wall_minutes: null, model: null, effort: null };
}

const Metadata = z.object({
  type: z.string().optional(),
  usage: z.unknown().optional(),
  total_cost_usd: z.unknown().optional(),
  model: z.unknown().optional(),
  modelUsage: z.unknown().optional(),
});
function metadata(raw: unknown): RunUsage {
  const parsed = Metadata.safeParse(raw);
  if (!parsed.success) return emptyUsage();
  const value = parsed.data;
  const counters = z.object({ input_tokens: z.unknown().optional(), output_tokens: z.unknown().optional() }).safeParse(value.usage).data;
  const models = Object.keys(z.record(z.string(), z.unknown()).safeParse(value.modelUsage).data ?? {});
  return {
    tokens_in: Tokens.safeParse(counters?.input_tokens).data ?? null,
    tokens_out: Tokens.safeParse(counters?.output_tokens).data ?? null,
    estimated_cost_usd: Amount.safeParse(value.total_cost_usd).data ?? null,
    wall_minutes: null,
    model: z.string().min(1).safeParse(value.model).data ??
      z.string().min(1).safeParse(models.length === 1 ? models[0] : undefined).data ?? null,
    effort: null,
  };
}

export function readAdapterUsage(input: { adapter: Adapter; stdout: string }): RunUsage {
  try {
    if (input.adapter === "custom" || input.adapter === "codex-plugin") return emptyUsage();
    if (input.adapter === "codex") {
      const events = input.stdout.trim().split("\n").filter((line) => line.trim()).map((line): unknown => JSON.parse(line));
      const completed = events.filter((event) => Metadata.safeParse(event).data?.type === "turn.completed");
      if (completed.length === 0) return emptyUsage();
      const usage = completed.map(metadata);
      const sum = (key: "tokens_in" | "tokens_out") => usage.every((item) => item[key] !== null)
        ? usage.reduce((total, item) => total + (item[key] ?? 0), 0) : null;
      return { ...emptyUsage(), tokens_in: sum("tokens_in"), tokens_out: sum("tokens_out") };
    }
    const raw: unknown = JSON.parse(input.stdout);
    if (input.adapter === "grok-plugin") {
      const payload = z.object({ result: z.unknown().optional(), grok: z.object({ stdout: z.string().optional() }).optional() }).parse(raw);
      const primary = metadata(payload.result);
      let fallback = emptyUsage();
      try { if (payload.grok?.stdout) fallback = metadata(JSON.parse(payload.grok.stdout)); } catch {}
      return { ...primary, tokens_in: primary.tokens_in ?? fallback.tokens_in, tokens_out: primary.tokens_out ?? fallback.tokens_out,
        estimated_cost_usd: primary.estimated_cost_usd ?? fallback.estimated_cost_usd, model: primary.model ?? fallback.model };
    }
    const messages = z.array(z.unknown()).safeParse(raw);
    return metadata(messages.success ? messages.data.findLast((item) => Metadata.safeParse(item).data?.type === "result") : raw);
  } catch { return emptyUsage(); }
}

export type UsageSample = { target: string; created_at: string; usage: RunUsage };
function totals(samples: UsageSample[]) {
  function metric(key: keyof Omit<RunUsage, "model" | "effort">) {
    const missing = samples.filter((sample) => sample.usage[key] === null).length;
    return { total: missing === 0 ? samples.reduce((sum, sample) => sum + (sample.usage[key] ?? 0), 0) : null, missing_runs: missing };
  }
  return { runs: samples.length, tokens_in: metric("tokens_in"), tokens_out: metric("tokens_out"),
    estimated_cost_usd: metric("estimated_cost_usd"), wall_minutes: metric("wall_minutes") };
}
export function aggregateUsage(samples: UsageSample[], now = new Date()) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const start7d = now.getTime() - 7 * 86400_000;
  function window(start: number) {
    const selected = samples.filter((sample) => {
      const time = Date.parse(sample.created_at);
      if (!Number.isFinite(time)) throw new Error("Invalid run created_at in usage records");
      return time >= start && time <= now.getTime();
    });
    const targets = [...new Set(selected.map((sample) => sample.target))].sort();
    return {
      since: new Date(start).toISOString(), ...totals(selected),
      by_target: targets.map((target) => ({ target, ...totals(selected.filter((sample) => sample.target === target)) })),
    };
  }
  return { ok: true, as_of: now.toISOString(), today: window(today.getTime()), last_7_days: window(start7d) };
}
