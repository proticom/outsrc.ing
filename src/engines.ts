import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { ensureOutsrcHome } from "./fs-home.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ENGINES, realScript, type PluginAdapter } from "./plugins.js";

// The lock pins each vendor plugin engine to one commit that passed npm run smoke:plugins.
export const LOCK_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "engines.lock.json");
const COMMIT = /^[0-9a-f]{40}$/;
const EntrySchema = z.object({ source: z.string().min(1), path: z.string().min(1), version: z.string().min(1), commit: z.string().regex(COMMIT) });
export type LockEntry = z.infer<typeof EntrySchema>;
const LockSchema = z.object({ "codex-plugin": EntrySchema.optional(), "grok-plugin": EntrySchema.optional() });
export type EngineLock = z.infer<typeof LockSchema>;

export function readLock(file = LOCK_FILE): EngineLock {
  return existsSync(file) ? LockSchema.parse(JSON.parse(readFileSync(file, "utf8"))) : {};
}

export function writeLockEntry(adapter: PluginAdapter, entry: LockEntry, file = LOCK_FILE): void {
  // Package lock lives in the repo/install tree, not ~/.outsrc.
  writeFileSync(file, `${JSON.stringify({ ...readLock(file), [adapter]: EntrySchema.parse(entry) }, null, 2)}\n`);
}

function engineRoot(home: string, adapter: PluginAdapter, commit: string): string {
  return join(home, "engines", adapter, commit);
}

export function managedScript(home: string, adapter: PluginAdapter, lock = readLock()): string | null {
  const entry = lock[adapter];
  if (!entry) return null;
  const script = join(engineRoot(home, adapter, entry.commit), ENGINES[adapter].script);
  return existsSync(script) ? realScript(script) : null;
}

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", stdio: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
}

// Fetches exactly the pinned commit and moves the plugin folder into place in one rename, so a rerun or a crash
// never leaves a half-written engine where resolution would find it.
export function installEngine(home: string, adapter: PluginAdapter, entry: LockEntry): string {
  const root = engineRoot(home, adapter, entry.commit);
  const script = join(root, ENGINES[adapter].script);
  if (existsSync(script)) return realScript(script);
  ensureOutsrcHome(home);
  mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
  const temp = mkdtempSync(join(dirname(root), ".fetch-"));
  try {
    git(["init", "-q", temp]);
    git(["-C", temp, "fetch", "-q", "--depth", "1", entry.source, entry.commit]);
    git(["-C", temp, "checkout", "-q", "FETCH_HEAD"]);
    const head = git(["-C", temp, "rev-parse", "HEAD"]).trim();
    if (head !== entry.commit) throw new Error(`fetched ${head}, expected ${entry.commit}`);
    const plugin = join(temp, entry.path);
    if (!existsSync(join(plugin, ENGINES[adapter].script))) throw new Error(`${entry.source} at ${entry.commit} has no ${entry.path}/${ENGINES[adapter].script}`);
    if (!existsSync(root)) renameSync(plugin, root);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  return realScript(script);
}

export function resolveCommit(source: string, ref: string): string {
  if (COMMIT.test(ref)) return ref;
  const line = git(["ls-remote", source, ref]).split("\n").find((text) => text.trim());
  const commit = line?.split(/\s+/)[0];
  if (!commit || !COMMIT.test(commit)) throw new Error(`${source} has no ref ${ref}`);
  return commit;
}
