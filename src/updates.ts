import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { ensureOutsrcHome } from "./fs-home.js";
import { readJson, writeJson } from "./state.js";
import { isBehind, parseVersion } from "./version.js";

export const PRODUCTS = ["claude", "codex", "grok", "outsrc"] as const;
export type Product = (typeof PRODUCTS)[number];

const Check = z.object({ installed: z.string().nullable(), latest: z.string().nullable(), error: z.string().nullable() });
export type Check = z.infer<typeof Check>;
const Pending = z.object({ installed: z.string(), latest: z.string(), first_seen_at: z.string() });
const StateSchema = z.object({
  version: z.literal(1),
  checked_at: z.string().nullable(),
  checks: z.partialRecord(z.enum(PRODUCTS), Check),
  pending: z.partialRecord(z.enum(PRODUCTS), Pending),
});
export type UpdatesState = z.infer<typeof StateSchema>;
const AckSchema = z.object({ version: z.literal(1), acked: z.array(z.string()) });

/** One pending update. id is "<product>@<latest>", so each new latest version is announced once. */
export type Notification = { id: string; product: Product; installed: string; latest: string; first_seen_at: string };

// refresh is the only writer of updates.json; ack is the only writer of updates-ack.json.
export function updatesFile(home: string): string { return join(home, "updates.json"); }
export function ackFile(home: string): string { return join(home, "updates-ack.json"); }

const EMPTY: UpdatesState = { version: 1, checked_at: null, checks: {}, pending: {} };

export function readUpdates(home: string): UpdatesState {
  const file = updatesFile(home);
  if (!existsSync(file)) return EMPTY;
  const parsed = StateSchema.safeParse(readJson(file));
  return parsed.success ? parsed.data : EMPTY;
}

function readAcks(home: string): string[] {
  const file = ackFile(home);
  if (!existsSync(file)) return [];
  const parsed = AckSchema.safeParse(readJson(file));
  return parsed.success ? parsed.data.acked : [];
}

export function notifications(state: UpdatesState): Notification[] {
  return PRODUCTS.flatMap((product) => {
    const entry = state.pending[product];
    return entry ? [{ id: `${product}@${entry.latest}`, product, ...entry }] : [];
  });
}

/** Pending updates the owner has not acknowledged yet. */
export function unread(home: string, state = readUpdates(home)): Notification[] {
  const acked = new Set(readAcks(home));
  return notifications(state).filter((note) => !acked.has(note.id));
}

export function ack(home: string, ids: string[] | "all"): string[] {
  const chosen = ids === "all" ? unread(home).map((note) => note.id) : ids;
  const acked = [...new Set([...readAcks(home), ...chosen])].slice(-200);
  ensureOutsrcHome(home);
  writeJson(ackFile(home), { version: 1, acked });
  return chosen;
}

export type Probe = { installed(product: Product): Promise<string>; latest(product: Product): Promise<string> };

type Settled = { version: string; error: null } | { version: null; error: string; missing: boolean };

async function settle(read: () => Promise<string>): Promise<Settled> {
  try {
    const text = await read();
    const version = parseVersion(text);
    return version ? { version: version.text, error: null } : { version: null, error: `no version in ${JSON.stringify(text.slice(0, 80))}`, missing: false };
  } catch (error) {
    const missing = (error as { code?: unknown }).code === "ENOENT";
    return { version: null, error: error instanceof Error ? error.message.split("\n")[0] ?? "failed" : String(error), missing };
  }
}

/**
 * Checks every product and records which are behind. Never installs anything.
 * A pending entry keeps its first_seen_at until a different latest version appears, so reruns are idempotent,
 * and a failed check keeps the previous entry instead of dropping it and announcing it again later.
 */
export async function refresh(home: string, probe: Probe, now = new Date()): Promise<{ state: UpdatesState; fresh: Notification[] }> {
  const previous = readUpdates(home);
  const checkedAt = now.toISOString();
  const results = await Promise.all(PRODUCTS.map(async (product) => {
    const [installed, latest] = await Promise.all([settle(() => probe.installed(product)), settle(() => probe.latest(product))]);
    return { product, installed, latest };
  }));
  const state: UpdatesState = { version: 1, checked_at: checkedAt, checks: {}, pending: {} };
  const fresh: Notification[] = [];
  for (const { product, installed, latest } of results) {
    state.checks[product] = { installed: installed.version, latest: latest.version, error: installed.error ?? latest.error };
    const before = previous.pending[product];
    if (installed.version === null || latest.version === null) {
      // An uninstalled CLI has nothing to update; any other failure keeps what the last good check found.
      const uninstalled = installed.version === null && installed.missing;
      if (before && !uninstalled) state.pending[product] = before;
      continue;
    }
    if (!isBehind(installed.version, latest.version)) continue;
    const entry = before?.latest === latest.version
      ? { ...before, installed: installed.version }
      : { installed: installed.version, latest: latest.version, first_seen_at: checkedAt };
    state.pending[product] = entry;
    if (before?.latest !== latest.version) fresh.push({ id: `${product}@${entry.latest}`, product, ...entry });
  }
  ensureOutsrcHome(home);
  writeJson(updatesFile(home), state);
  return { state, fresh };
}

const run = promisify(execFile);
const TIMEOUT_MS = 20_000;
const NPM_PACKAGE: Partial<Record<Product, string>> = { claude: "@anthropic-ai/claude-code", codex: "@openai/codex", outsrc: "outsrc" };
const PACKAGE_JSON = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");

async function stdout(command: string, args: string[]): Promise<string> {
  return (await run(command, args, { timeout: TIMEOUT_MS, encoding: "utf8" })).stdout;
}

/** Version queries only: `<cli> --version`, the npm registry, and `grok update --check`. No model calls. */
export const defaultProbe: Probe = {
  async installed(product) {
    if (product === "outsrc") return (JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as { version: string }).version;
    return stdout(product, ["--version"]);
  },
  async latest(product) {
    if (product === "grok") {
      const body = JSON.parse(await stdout("grok", ["update", "--check", "--json"])) as { latestVersion?: unknown };
      if (typeof body.latestVersion !== "string") throw new Error("grok update --check gave no latestVersion");
      return body.latestVersion;
    }
    const name = NPM_PACKAGE[product];
    if (!name) throw new Error(`no registry package for ${product}`);
    const response = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}/latest`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) throw new Error(`npm registry ${response.status} for ${name}`);
    const body = (await response.json()) as { version?: unknown };
    if (typeof body.version !== "string") throw new Error(`npm registry gave no version for ${name}`);
    return body.version;
  },
};
