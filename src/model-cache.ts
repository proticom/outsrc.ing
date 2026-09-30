import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Adapter, AdapterTarget } from "./adapters.js";
import { ensureOutsrcHome, writeHomeFile } from "./fs-home.js";
import { discoverModels, type ModelOptions } from "./models.js";

export type Discover = (adapter: Adapter, command: string) => ModelOptions | null;

const EntrySchema = z.object({
  adapter: z.string(),
  command: z.string(),
  refreshedAt: z.string(),
  models: z.object({ default: z.string(), allowed: z.array(z.string()) }).nullable(),
});
export type ModelCacheEntry = z.infer<typeof EntrySchema>;
const CacheSchema = z.object({ version: z.literal(1), targets: z.record(z.string(), EntrySchema) });

export function modelCachePath(home: string): string {
  return join(home, "models.json");
}

/** A missing or unreadable cache reads as empty, so the next lookup rediscovers. */
export function readModelCache(home: string): Record<string, ModelCacheEntry> {
  const file = modelCachePath(home);
  if (!existsSync(file)) return {};
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch { return {}; }
  const parsed = CacheSchema.safeParse(raw);
  return parsed.success ? parsed.data.targets : {};
}

function writeModelCache(home: string, targets: Record<string, ModelCacheEntry>): void {
  ensureOutsrcHome(home);
  const file = modelCachePath(home);
  const temp = `${file}.${process.pid}.tmp`;
  writeHomeFile(temp, `${JSON.stringify({ version: 1, targets }, null, 2)}\n`);
  renameSync(temp, file);
}

/**
 * Cached models per target. A target is discovered when it has no entry, when its adapter or command changed
 * since the entry was written, or when `refresh` names it. Everything else is served from the file without
 * spawning a vendor CLI. Discovery only runs each vendor's model-list command; it never runs a model.
 */
export function resolveModels(options: {
  home: string;
  targets: Record<string, AdapterTarget>;
  refresh?: boolean;
  discover?: Discover;
}): Record<string, ModelCacheEntry> {
  const discover = options.discover ?? discoverModels;
  const cache = readModelCache(options.home);
  const result: Record<string, ModelCacheEntry> = {};
  let changed = false;
  for (const [name, target] of Object.entries(options.targets)) {
    const cached = cache[name];
    if (!options.refresh && cached && cached.adapter === target.adapter && cached.command === target.command) {
      result[name] = cached;
      continue;
    }
    const entry = { adapter: target.adapter, command: target.command, refreshedAt: new Date().toISOString(), models: discover(target.adapter, target.command) };
    cache[name] = entry;
    result[name] = entry;
    changed = true;
  }
  if (changed) writeModelCache(options.home, cache);
  return result;
}
