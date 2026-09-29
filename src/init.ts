import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { ensureOutsrcHome, writeHomeFile } from "./fs-home.js";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "smol-toml";
import { z } from "zod";
import { loadConfigFile } from "./config.js";
import { changeSetting, listSettings, RISKS } from "./settings.js";
import { createMailbox } from "./mailbox.js";
import { checkPluginContract } from "./plugin-contract.js";
import { installEngine, managedScript, readLock } from "./engines.js";
import { isPluginAdapter, resolvePluginScript, type PluginAdapter } from "./plugins.js";

export type Cli = "claude" | "codex" | "grok";
const CLIS: Cli[] = ["claude", "codex", "grok"];

export type Run = { status: number | null; stdout: string; stderr: string };
// Everything the wizard touches outside its own process, so tests can assert the exact commands.
export type InitEnv = {
  configPath: string;
  serverCommand: string[];
  which: (command: string) => string | null;
  run: (command: string, args: string[]) => Run;
  runInteractive: (command: string, args: string[]) => number | null;
  runStreaming: (command: string, args: string[], onLine: (line: string) => void) => Promise<number | null>;
  emit: (event: Record<string, unknown>) => void;
  confirm: (question: string, fallback: boolean) => Promise<boolean>;
  ask: (question: string) => Promise<string>;
  print: (line: string) => void;
  // outsrc's own pinned download, and separately a Claude Code install of the same plugin (the fallback).
  engineScript: (adapter: PluginAdapter) => string | null;
  claudeEngine: (adapter: PluginAdapter) => string | null;
  installEngine: (adapter: PluginAdapter) => { version: string; commit: string };
};
export type InitOptions = {
  repos: string[]; yes: boolean; json: boolean; plugins: boolean | null;
  local: Cli[] | null;
  limits: { max_jobs?: string; max_run_minutes?: string };
};
// Exit code for "stopped for a person": the caller should relay the needs_human events and rerun init.
export const NEEDS_HUMAN = 3;

export function parseInitArgs(argv: string[]): InitOptions {
  const options: InitOptions = { repos: [], yes: false, json: false, plugins: null, local: null, limits: {} };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = () => { const value = argv[++index]; if (value === undefined) throw new Error(`${arg} needs a value`); return value; };
    if (arg === "--repo") options.repos.push(next());
    else if (arg === "--yes" || arg === "-y") options.yes = true;
    else if (arg === "--json") { options.json = true; options.yes = true; }
    else if (arg === "--plugins") options.plugins = true;
    else if (arg === "--no-plugins") options.plugins = false;
    else if (arg === "--local") options.local = z.array(z.enum(["claude", "codex", "grok"])).parse(next().split(",").filter(Boolean));
    else if (arg === "--max-jobs") options.limits.max_jobs = next();
    else if (arg === "--max-run-minutes") options.limits.max_run_minutes = next();
    else throw new Error(`unknown init option: ${arg}`);
  }
  return options;
}

type RepoEntry = { alias: string; path: string };
type TargetEntry = Record<string, unknown>;

export function targetFor(cli: Cli, path: string, useEngine: boolean): TargetEntry {
  const description = {
    claude: "Coding tasks and review through the Claude Code CLI.",
    codex: "Coding tasks and code review through Codex, including its built-in and adversarial reviewers.",
    grok: "Coding tasks and critique through Grok Build.",
  }[cli];
  const effort = cli === "grok" ? ["low", "medium", "high"] : cli === "codex" ? ["low", "medium", "high", "xhigh"] : ["low", "medium", "high", "xhigh", "max"];
  // Engine targets carry no command: it resolves at load to the engine pinned in engines.lock.json.
  const engine = useEngine && cli !== "claude" ? { adapter: `${cli}-plugin` } : { adapter: cli, command: path, args: [] };
  return { ...engine, permissions: "auto", description, cost_note: `Uses this machine's ${cli} account.`, effort: { default: "medium", allowed: effort } };
}

const ExistingSchema = z.object({
  repos: z.array(z.object({ alias: z.string(), path: z.string() }).passthrough()).default([]),
  targets: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
}).passthrough();

// Existing repos and targets win; the wizard only adds what is missing, so reruns change nothing.
export function mergeConfig(existing: string | null, repos: RepoEntry[], targets: Record<string, TargetEntry>): { toml: string; addedRepos: string[]; addedTargets: string[] } {
  const current = ExistingSchema.parse(existing ? parse(existing) : {});
  const addedRepos: string[] = [];
  const aliases = new Set(current.repos.map((repo) => repo.alias));
  for (const repo of repos) {
    if (current.repos.some((item) => resolve(item.path) === resolve(repo.path))) continue;
    let alias = repo.alias;
    for (let n = 2; aliases.has(alias); n++) alias = `${repo.alias}-${n}`;
    aliases.add(alias);
    current.repos.push({ alias, path: repo.path });
    addedRepos.push(alias);
  }
  const addedTargets = Object.keys(targets).filter((name) => !(name in current.targets));
  for (const name of addedTargets) current.targets[name] = targets[name] ?? {};
  return { toml: stringify(current), addedRepos, addedTargets };
}

function repoEntry(env: InitEnv, input: string): RepoEntry {
  const top = env.run("git", ["-C", resolve(input), "rev-parse", "--show-toplevel"]);
  if (top.status !== 0) throw new Error(`not a git repository: ${input}`);
  const path = top.stdout.trim();
  const alias = basename(path).toLowerCase().replace(/[^a-z0-9._-]+/g, "-") || "repo";
  return { alias, path };
}

const LocalCommands: Record<Cli, { registered: string[] | null; add: (server: string[]) => string[] }> = {
  claude: { registered: ["mcp", "get", "outsrc"], add: (server) => ["mcp", "add", "--scope", "user", "outsrc", "--", ...server] },
  codex: { registered: ["mcp", "get", "outsrc"], add: (server) => ["mcp", "add", "outsrc", "--", ...server] },
  grok: { registered: null, add: (server) => ["mcp", "add", "--scope", "user", "outsrc", "--", ...server] },
};

const LOGIN: Record<Cli, { check: string[]; loggedIn: (result: Run) => boolean; interactive: string[]; headless: string }> = {
  claude: { check: ["auth", "status", "--json"], loggedIn: (r) => r.status === 0 && /"loggedIn":\s*true/.test(r.stdout), interactive: ["auth", "login"], headless: "claude auth login" },
  codex: { check: ["login", "status"], loggedIn: (r) => r.status === 0, interactive: ["login"], headless: "codex login --device-auth" },
  grok: { check: ["models"], loggedIn: (r) => r.status === 0, interactive: ["login"], headless: "grok login --device-auth" },
};

const PLUGINS = {
  codex: { adapter: "codex-plugin", repo: "openai/codex-plugin-cc", adds: "Codex's own reviewer and adversarial review" },
  grok: { adapter: "grok-plugin", repo: "xai-org/grok-build-plugin-cc", adds: "Grok's review and critique commands" },
} as const;
export async function runInit(env: InitEnv, options: InitOptions): Promise<number> {
  const say = env.print;
  say("outsrc setup. It is safe to run again; existing settings are kept.\n");

  const pending: Record<string, unknown>[] = [];
  function needsHuman(step: Record<string, unknown> & { step: string; instructions: string }): void {
    pending.push(step);
    env.emit({ event: "needs_human", ...step });
    say(`  ACTION FOR A PERSON: ${step.instructions}`);
  }
  function finish(status: number, extra: Record<string, unknown> = {}): number {
    const code = status === 0 && pending.length ? NEEDS_HUMAN : status;
    env.emit({ event: "done", status: code === 0 ? "ok" : code === NEEDS_HUMAN ? "needs_human" : "error", config: env.configPath, pending, ...extra });
    if (code === NEEDS_HUMAN) say("\nFinish the actions above, then run outsrc init again. It picks up where it stopped.");
    return code;
  }

  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (!((major === 22 && minor >= 12) || major === 24 || major >= 26)) {
    say(`Node ${process.version} is not supported. Use 22.12+, 24 or 26+.`);
    return finish(1, { error: "unsupported node" });
  }
  if (!env.which("git")) { say("git is required."); return finish(1, { error: "git not found" }); }

  const found = Object.fromEntries(CLIS.map((cli) => [cli, env.which(cli)])) as Record<Cli, string | null>;
  say("Agent CLIs on this machine:");
  for (const cli of CLIS) say(`  ${cli}: ${found[cli] ?? "not found"}`);
  if (!CLIS.some((cli) => found[cli])) {
    say("\nInstall at least one of claude, codex or grok, log in, then run outsrc init again.");
    return finish(1, { error: "no agent CLI found" });
  }

  for (const cli of CLIS) {
    if (!found[cli]) continue;
    const login = LOGIN[cli];
    if (login.loggedIn(env.run(cli, login.check))) continue;
    if (!options.yes && await env.confirm(`  ${cli} is not logged in. Log in now? This opens a browser.`, true)) {
      env.runInteractive(cli, login.interactive);
      if (login.loggedIn(env.run(cli, login.check))) continue;
    }
    needsHuman({ step: "login", cli, command: login.headless, instructions: `Log in to ${cli}: run \`${login.headless}\` on this machine and finish the sign-in.` });
  }

  const engines = new Set<Cli>();
  for (const cli of ["codex", "grok"] as const) {
    const plugin = PLUGINS[cli];
    if (!found[cli]) continue;
    if (env.engineScript(plugin.adapter)) { engines.add(cli); continue; }
    const wanted = options.plugins ?? (options.yes || await env.confirm(`  Download the ${plugin.repo} engine into outsrc? It adds ${plugin.adds}. Claude Code is not needed.`, true));
    const fallback = env.claudeEngine(plugin.adapter) ? "using Claude Code's copy of the plugin, which is not pinned" : "calling the CLI directly";
    if (!wanted) { say(`  ${cli}: ${fallback}`); }
    else {
      try {
        const pinned = env.installEngine(plugin.adapter);
        engines.add(cli);
        say(`  ${cli}: downloaded ${plugin.repo} ${pinned.version} (${pinned.commit.slice(0, 7)})`);
        continue;
      } catch (error) {
        say(`  ${cli}: could not download ${plugin.repo}, ${fallback}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (env.claudeEngine(plugin.adapter)) engines.add(cli);
  }

  const targets: Record<string, TargetEntry> = {};
  for (const cli of CLIS) {
    const path = found[cli];
    if (path) targets[cli] = targetFor(cli, path, engines.has(cli));
  }

  say("\nRepositories agents may start work in. outsrc refuses any other repository, but the agent CLIs are not sandboxed to these folders.");
  const repos: RepoEntry[] = [];
  for (const path of options.repos) repos.push(repoEntry(env, path));
  if (!options.yes) {
    for (;;) {
      const answer = (await env.ask("  Repository path (blank when done): ")).trim();
      if (!answer) break;
      try { const entry = repoEntry(env, answer); repos.push(entry); say(`  added ${entry.alias} -> ${entry.path}`); }
      catch (error) { say(`  ${error instanceof Error ? error.message : String(error)}`); }
    }
  }

  ensureOutsrcHome(dirname(env.configPath));
  const merged = mergeConfig(existsSync(env.configPath) ? readFileSync(env.configPath, "utf8") : null, repos, targets);
  writeHomeFile(env.configPath, merged.toml);
  say(`\nWrote ${env.configPath}. New repositories: ${merged.addedRepos.join(", ") || "none"}. New targets: ${merged.addedTargets.join(", ") || "none"}.`);

  const LIMIT_QUESTIONS = {
    max_jobs: "Most jobs working at once (a number, or unlimited)",
    max_run_minutes: "Longest a run may take, in minutes (a number, or unlimited)",
  } as const;
  for (const name of ["max_jobs", "max_run_minutes"] as const) {
    let answer = options.limits[name];
    if (answer === undefined && !options.yes) {
      const current = listSettings(env.configPath).limits[name];
      answer = (await env.ask(`  ${LIMIT_QUESTIONS[name]} [${current}]: `)).trim() || undefined;
      if (answer === "unlimited" && !await env.confirm(`  ${RISKS[`limits.${name}`]} Use unlimited?`, false)) answer = undefined;
    }
    if (answer === undefined) continue;
    const change = changeSetting(env.configPath, `limits.${name}`, answer);
    if (!change.ok) throw new Error(change.error);
    say(`  limits.${name} = ${answer}${change.warning ? `. ${change.warning}` : ""}`);
  }

  const config = loadConfigFile(env.configPath);
  const settings = listSettings(env.configPath);
  env.emit({ event: "settings", limits: settings.limits, repos: settings.repos.map((repo) => repo.alias), targets: Object.keys(settings.targets),
    instructions: "Review these with the owner: run outsrc config for every setting and its meaning, and outsrc config set <key> <value> for each change they ask for." });
  say(`\nLimits: ${settings.limits.max_jobs} jobs at once, ${settings.limits.max_run_minutes} minutes per run. See every setting with outsrc config.`);
  if (config.repos.length === 0) say("No repositories are configured yet. Run outsrc init again with --repo <path>.");
  const box = createMailbox({ home: dirname(env.configPath), config });
  for (const target of box.listTargets().targets) {
    const warning = "warning" in target ? ` (${String(target.warning)})` : "";
    say(`  target ${target.name}: ${target.available ? "available" : "NOT available"}${warning}`);
  }
  for (const target of Object.values(config.targets)) {
    if (target.adapter && isPluginAdapter(target.adapter) && target.command) {
      const report = checkPluginContract(target.adapter, target.command);
      if (report.status === "broken") say(`  ${target.adapter} ${report.version ?? ""} is incompatible: ${report.problems.join("; ")}`);
    }
  }

  const ephemeral = env.serverCommand.some((part) => part.includes("/_npx/"));
  if (ephemeral) {
    say("\nYou ran outsrc through npx, whose files live in a temporary cache. Install it with `npm i -g outsrc` and run `outsrc init` again to connect agents to a stable copy.");
    return finish(0, { error: "npx copy not registered" });
  }

  say("\nLocal agents can call outsrc as an MCP server to hand work to the other CLIs.");
  for (const cli of CLIS) {
    if (!found[cli]) continue;
    const wanted = options.local ? options.local.includes(cli) : options.yes ? false : await env.confirm(`  Add outsrc to ${cli}?`, true);
    if (!wanted) continue;
    const commands = LocalCommands[cli];
    if (commands.registered && env.run(cli, commands.registered).status === 0) { say(`  ${cli}: already has outsrc`); continue; }
    const added = env.run(cli, commands.add([...env.serverCommand, "--caller", cli]));
    say(added.status === 0 ? `  ${cli}: added outsrc` : `  ${cli}: could not add outsrc: ${added.stderr.trim() || added.stdout.trim()}`);
  }

  say("\nDone. Run `outsrc doctor` any time to recheck.");
  return finish(0);
}


function lookup(command: string): string | null {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory, command);
    // Keep the PATH entry, not its target: ~/.local/bin/claude points at a versioned binary that updates replace.
    if (directory && existsSync(candidate)) return candidate;
  }
  return null;
}

export function defaultInitEnv(configPath: string, json = false): InitEnv & { close: () => void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const server = join(dirname(fileURLToPath(import.meta.url)), "server.js");
  return {
    configPath,
    serverCommand: [process.execPath, existsSync(server) ? realpathSync(server) : server],
    which: lookup,
    run: (command, args) => {
      const result = spawnSync(command, args, { encoding: "utf8", timeout: 120_000 });
      return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? String(result.error ?? "") };
    },
    runInteractive: (command, args) => spawnSync(command, args, { stdio: "inherit" }).status,
    runStreaming: (command, args, onLine) => new Promise((done) => {
      const child = spawn(command, args, { stdio: ["inherit", "pipe", "inherit"] });
      let buffer = "";
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
          onLine(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
        }
      });
      child.once("error", () => done(null));
      child.once("close", (code) => { if (buffer) onLine(buffer); done(code); });
    }),
    emit: (event) => { if (json) process.stdout.write(`${JSON.stringify(event)}\n`); },
    confirm: async (question, fallback) => {
      const answer = (await rl.question(`${question} ${fallback ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
      return answer ? answer.startsWith("y") : fallback;
    },
    ask: (question) => rl.question(question),
    print: (line) => (json ? process.stderr : process.stdout).write(`${line}\n`),
    engineScript: (adapter) => managedScript(dirname(configPath), adapter),
    claudeEngine: (adapter) => resolvePluginScript(adapter),
    installEngine: (adapter) => {
      const entry = readLock()[adapter];
      if (!entry) throw new Error(`engines.lock.json has no ${adapter} entry`);
      installEngine(dirname(configPath), adapter, entry);
      return { version: entry.version, commit: entry.commit };
    },
    close: () => rl.close(),
  };
}
