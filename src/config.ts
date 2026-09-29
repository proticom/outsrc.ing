import { readFileSync } from "node:fs";
import { parse } from "smol-toml";
import { z } from "zod";
import { dirname } from "node:path";
import { managedScript } from "./engines.js";
import { isPluginAdapter, realScript, resolvePluginScript } from "./plugins.js";
import { DEFAULT_LIMITS } from "./limits.js";
import type { Config, RepoConfig, TargetConfig } from "./types.js";

const Options = z.object({ default: z.string(), allowed: z.array(z.string()).min(1) })
  .refine((options) => options.allowed.includes(options.default), { message: "default must be one of allowed" });
const TargetSchema = z.object({
  adapter: z.enum(["claude", "codex", "grok", "custom", "codex-plugin", "grok-plugin"]).optional(),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).default([]),
  permissions: z.enum(["auto", "ask"]).optional(),
  models: Options.optional(),
  effort: Options.optional(),
  description: z.string().optional(),
  cost_note: z.string().optional(),
});
// A positive whole number, or "unlimited".
const Limit = z.union([z.number().int().positive(), z.literal("unlimited")]);
export const ConfigSchema = z.object({
  limits: z.object({ max_jobs: Limit.optional(), max_run_minutes: Limit.optional() }).strict().default({}),
  repos: z.array(z.object({
    alias: z.string().min(1),
    path: z.string().min(1),
    setup: z.array(z.array(z.string()).min(1)).optional(),
    auto_commit: z.boolean().optional(),
    retention_days: z.number().positive().optional(),
  })).default([]),
  targets: z.record(z.string(), TargetSchema).default({}),
});

export function loadConfigFile(path: string): Config {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch { throw new Error(`config not found: ${path}`); }
  return configFromDocument(parse(raw), path);
}

/** Validate a parsed config document. Throws with the first problem. */
export function configFromDocument(document: unknown, path: string): Config {
  const parsed = ConfigSchema.parse(document);
  const repos: RepoConfig[] = parsed.repos.map((repo) => ({
    alias: repo.alias,
    path: repo.path,
    ...(repo.setup !== undefined ? { setup: repo.setup } : {}),
    ...(repo.auto_commit !== undefined ? { autoCommit: repo.auto_commit } : {}),
    ...(repo.retention_days !== undefined ? { retentionDays: repo.retention_days } : {}),
  }));
  const targets: Record<string, TargetConfig> = {};
  for (const [name, target] of Object.entries(parsed.targets)) {
    const adapter = target.adapter;
    let command = target.command;
    if (command === undefined) {
      // An unresolved plugin keeps an empty command so list_targets reports it unavailable instead of failing startup.
      // outsrc's pinned engine wins; a Claude Code install of the same plugin is the fallback.
      if (adapter !== undefined && isPluginAdapter(adapter)) command = managedScript(dirname(path), adapter) ?? resolvePluginScript(adapter) ?? "";
      else throw new Error(`target ${name} needs a command`);
    } else if (adapter !== undefined && isPluginAdapter(adapter)) {
      command = realScript(command);
    }
    targets[name] = {
      command,
      args: target.args,
      ...(target.adapter !== undefined ? { adapter: target.adapter } : {}),
      ...(target.permissions !== undefined ? { permissions: target.permissions } : {}),
      ...(target.models !== undefined ? { models: target.models } : {}),
      ...(target.effort !== undefined ? { effort: target.effort } : {}),
      ...(target.description !== undefined ? { description: target.description } : {}),
      ...(target.cost_note !== undefined ? { costNote: target.cost_note } : {}),
    };
  }
  const limit = (value: number | "unlimited" | undefined, fallback: number) => value === "unlimited" ? null : value ?? fallback;
  const limits = {
    maxJobs: limit(parsed.limits.max_jobs, DEFAULT_LIMITS.max_jobs),
    maxRunMinutes: limit(parsed.limits.max_run_minutes, DEFAULT_LIMITS.max_run_minutes),
  };
  return { repos, targets, limits };
}
export function defaultHome(): string { return process.env.OUTSRC_HOME ?? `${process.env.HOME}/.outsrc`; }
export function defaultConfigPath(home = defaultHome()): string { return `${home}/config.toml`; }
