import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { parse, stringify } from "smol-toml";
import { configFromDocument } from "./config.js";
import { ensureOutsrcHome, writeHomeFile } from "./fs-home.js";
import { DEFAULT_LIMITS, resolveLimits } from "./limits.js";

// Every setting an owner can change, with its default and what it means. Keys use the config.toml names.
export const SETTINGS_HELP = [
  { key: "limits.max_jobs", values: 'positive whole number or "unlimited"', default: DEFAULT_LIMITS.max_jobs, meaning: "Most jobs working at once, across every caller." },
  { key: "limits.max_run_minutes", values: 'positive whole number or "unlimited"', default: DEFAULT_LIMITS.max_run_minutes, meaning: "A run is stopped after this long." },
  { key: "repos.<alias>", values: '{"path": "/absolute/path"}', default: null, meaning: "Add a repository agents may work in. unset removes it." },
  { key: "repos.<alias>.path", values: "absolute path to a git checkout", default: null, meaning: "Where the repository lives." },
  { key: "repos.<alias>.setup", values: 'JSON list of commands, e.g. [["npm","ci"]]', default: [], meaning: "Runs once in a new task worktree before the first run. Never runs for reviews." },
  { key: "repos.<alias>.auto_commit", values: "true or false", default: false, meaning: "Commit a successful task's changes on the agent branch." },
  { key: "repos.<alias>.retention_days", values: "positive number", default: null, meaning: "outsrc prune removes finished worktrees older than this. Unset keeps them." },
  { key: "targets.<name>", values: 'JSON object, e.g. {"adapter":"claude","command":"claude"}', default: null, meaning: "Add an agent outsrc can start. unset removes it." },
  { key: "targets.<name>.permissions", values: '"auto" or "ask"', default: "auto", meaning: "auto lets tasks edit and run commands without approval. Reviews always run as ask." },
  { key: "targets.<name>.effort.default", values: "one of effort.allowed", default: null, meaning: "Effort used when a request names none." },
  { key: "targets.<name>.effort.allowed", values: "comma list or JSON list", default: null, meaning: "Efforts a request may choose." },
  { key: "targets.<name>.models.default", values: "one of models.allowed", default: null, meaning: "Model used when a request names none. Without models, the CLI picks." },
  { key: "targets.<name>.models.allowed", values: "comma list or JSON list", default: null, meaning: "Models a request may choose." },
  { key: "targets.<name>.description", values: "text", default: "", meaning: "Shown to callers in list_targets." },
  { key: "targets.<name>.cost_note", values: "text", default: "", meaning: "Shown to callers in list_targets." },
  { key: "targets.<name>.adapter", values: "claude, codex, grok, codex-plugin, grok-plugin or custom", default: null, meaning: "How outsrc drives the agent." },
  { key: "targets.<name>.command", values: "program path", default: null, meaning: "The program outsrc runs, as you." },
  { key: "targets.<name>.args", values: "JSON list of strings", default: [], meaning: "Extra arguments for the program." },
] as const;

export const RISKS = {
  "limits.max_jobs": "No cap on jobs working at once. A looping or confused bot can start many agents together: the computer slows down, usage and cost climb quickly, and providers may rate-limit the account.",
  "limits.max_run_minutes": "No time limit on a run. A stuck agent (waiting for input it cannot get, a test runner in watch mode, a loop) keeps running and spending until someone stops it.",
  "permissions.auto": "Tasks on this target edit files and run commands without asking. That is how unattended work gets done, and it is also why only the owner should choose the repositories.",
  command: "outsrc will run this program as you, with your files and accounts.",
} as const;

type Document = { limits?: Record<string, unknown>; repos?: Record<string, unknown>[]; targets?: Record<string, Record<string, unknown>> } & Record<string, unknown>;
type Key =
  | { kind: "limit"; name: "max_jobs" | "max_run_minutes" }
  | { kind: "repo"; alias: string; field: string | null }
  | { kind: "target"; name: string; field: string[] | null };

const REPO_FIELDS = ["path", "setup", "auto_commit", "retention_days"];
const TARGET_FIELDS = ["models.default", "models.allowed", "effort.default", "effort.allowed", "models", "effort",
  "adapter", "command", "args", "permissions", "description", "cost_note"];

// Aliases may contain dots (a repository named outsrc.ing), so the field is matched from the end.
export function parseKey(key: string): Key {
  if (key === "limits.max_jobs" || key === "limits.max_run_minutes") return { kind: "limit", name: key.slice("limits.".length) as "max_jobs" | "max_run_minutes" };
  for (const [prefix, fields, kind] of [["repos.", REPO_FIELDS, "repo"], ["targets.", TARGET_FIELDS, "target"]] as const) {
    if (!key.startsWith(prefix) || key.length === prefix.length) continue;
    const rest = key.slice(prefix.length);
    const field = fields.find((candidate) => rest.endsWith(`.${candidate}`) && rest.length > candidate.length + 1);
    const name = field ? rest.slice(0, -(field.length + 1)) : rest;
    if (kind === "repo") return { kind, alias: name, field: field ?? null };
    return { kind, name, field: field ? field.split(".") : null };
  }
  throw new Error(`unknown setting: ${key}. Run outsrc config to see every setting`);
}

function parseValue(key: Key, raw: string): unknown {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { value = raw; }
  if (key.kind === "target" && key.field?.at(-1) === "allowed" && typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return value;
}

function readDocument(path: string): Document {
  return existsSync(path) ? parse(readFileSync(path, "utf8")) as Document : {};
}

function gitTop(path: string): string {
  if (!isAbsolute(path)) throw new Error(`repository path must be absolute: ${path}`);
  try { return execFileSync("git", ["-C", path, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { throw new Error(`not a git repository: ${path}`); }
}

function apply(document: Document, key: Key, value: unknown | undefined): void {
  if (key.kind === "limit") {
    const limits = { ...(document.limits ?? {}) };
    if (value === undefined) delete limits[key.name]; else limits[key.name] = value;
    document.limits = limits;
    return;
  }
  if (key.kind === "repo") {
    const repos = [...(document.repos ?? [])];
    const index = repos.findIndex((repo) => repo.alias === key.alias);
    if (key.field === null) {
      if (value === undefined) { if (index < 0) throw new Error(`unknown repository: ${key.alias}`); repos.splice(index, 1); }
      else {
        if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`repos.${key.alias} takes a JSON object such as {"path": "/absolute/path"}`);
        const entry: Record<string, unknown> = { ...(index >= 0 ? repos[index] : {}), ...(value as Record<string, unknown>), alias: key.alias };
        if (typeof entry.path === "string") entry.path = gitTop(entry.path);
        if (index >= 0) repos[index] = entry; else repos.push(entry);
      }
    } else {
      if (index < 0 && !(key.field === "path" && value !== undefined)) throw new Error(`unknown repository: ${key.alias}`);
      const entry: Record<string, unknown> = { ...(index >= 0 ? repos[index] : { alias: key.alias }) };
      if (value === undefined) delete entry[key.field]; else entry[key.field] = value;
      if (key.field === "path" && typeof entry.path === "string") entry.path = gitTop(entry.path);
      if (index >= 0) repos[index] = entry; else repos.push(entry);
    }
    document.repos = repos;
    return;
  }
  const targets = { ...(document.targets ?? {}) };
  if (key.field === null) {
    if (value === undefined) { if (!(key.name in targets)) throw new Error(`unknown target: ${key.name}`); delete targets[key.name]; }
    else {
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`targets.${key.name} takes a JSON object`);
      targets[key.name] = { ...(targets[key.name] ?? {}), ...(value as Record<string, unknown>) };
    }
  } else {
    if (!(key.name in targets)) throw new Error(`unknown target: ${key.name}. Add it first with outsrc config set targets.${key.name} '{"adapter": ..., "command": ...}'`);
    const target: Record<string, unknown> = structuredClone(targets[key.name] ?? {});
    const [head = "", sub] = key.field;
    if (sub === undefined) { if (value === undefined) delete target[head]; else target[head] = value; }
    else {
      const nested = { ...((target[head] as Record<string, unknown> | undefined) ?? {}) };
      if (value === undefined) delete nested[sub]; else nested[sub] = value;
      if (Object.keys(nested).length) target[head] = nested; else delete target[head];
    }
    targets[key.name] = target;
  }
  document.targets = targets;
}

function risk(key: string, value: unknown): string | null {
  if ((key === "limits.max_jobs" || key === "limits.max_run_minutes") && value === "unlimited") return RISKS[key];
  if (key.endsWith(".permissions") && value === "auto") return RISKS["permissions.auto"];
  if (key.endsWith(".command")) return RISKS.command;
  return null;
}

export type SettingChange = { ok: true; key: string; value: unknown; warning: string | null } | { ok: false; error: string };

/** Set (or with value undefined, remove) one setting. The file is only written if the whole config stays valid. */
export function changeSetting(configPath: string, key: string, raw: string | undefined): SettingChange {
  try {
    const parsed = parseKey(key);
    const value = raw === undefined ? undefined : parseValue(parsed, raw);
    if (value === "off" && parsed.kind === "repo" && parsed.field === "retention_days") return changeSetting(configPath, key, undefined);
    const document = readDocument(configPath);
    apply(document, parsed, value);
    configFromDocument(document, configPath);
    ensureOutsrcHome(dirname(configPath));
    if (existsSync(configPath)) copyFileSync(configPath, `${configPath}.bak`);
    writeHomeFile(configPath, stringify(document));
    return { ok: true, key, value: value ?? null, warning: risk(key, value) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message.startsWith("[") ? `invalid value for ${key}: ${message}` : message };
  }
}

/** Every setting with its effective value, plus the keys an owner can change. */
export function listSettings(configPath: string) {
  const config = configFromDocument(readDocument(configPath), configPath);
  const limits = resolveLimits(config.limits);
  return {
    config_path: configPath,
    limits: { max_jobs: limits.maxJobs ?? "unlimited", max_run_minutes: limits.maxRunMinutes ?? "unlimited" },
    repos: config.repos.map((repo) => ({
      alias: repo.alias, path: repo.path, setup: repo.setup ?? [], auto_commit: repo.autoCommit ?? false, retention_days: repo.retentionDays ?? null,
    })),
    targets: Object.fromEntries(Object.entries(config.targets).map(([name, target]) => [name, {
      adapter: target.adapter ?? name, command: target.command, args: target.args, permissions: target.permissions ?? "auto",
      models: target.models ?? null, effort: target.effort ?? null, description: target.description ?? "", cost_note: target.costNote ?? "",
    }])),
    change_with: "outsrc config set <key> <value>; outsrc config unset <key> restores the default",
    settings: SETTINGS_HELP,
  };
}
