#!/usr/bin/env node
import { spawn } from "node:child_process";
import { defaultConfigPath, defaultHome, loadConfigFile } from "./config.js";
import { migrateLegacy } from "./migrate.js";
import { changeSetting, listSettings } from "./settings.js";
import { defaultInitEnv, parseInitArgs, runInit } from "./init.js";
import { createMailbox } from "./mailbox.js";
import { installEngine, managedScript, readLock, resolveCommit, writeLockEntry } from "./engines.js";
import { checkPluginContract, pluginVersion, type ContractReport } from "./plugin-contract.js";
import { isPluginAdapter, resolvePluginScript, type PluginAdapter } from "./plugins.js";
import { startStreamServer } from "./streams.js";
import { DEFAULT_CALLER, parseCaller, parseThreadId, type SendInput } from "./types.js";

function pluginReports(explicit: Partial<Record<PluginAdapter, string>>): ContractReport[] {
  return (["codex-plugin", "grok-plugin"] as const).flatMap((adapter) => {
    const script = explicit[adapter] ?? managedScript(defaultHome(), adapter) ?? resolvePluginScript(adapter);
    return script ? [checkPluginContract(adapter, script)] : [];
  });
}

function flagValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function takeFlag(argv: string[], name: string): { value?: string; rest: string[] } {
  const index = argv.indexOf(name);
  if (index < 0) return { rest: argv };
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("-")) throw new Error(`${name} needs a value`);
  return { value, rest: [...argv.slice(0, index), ...argv.slice(index + 2)] };
}

function parseMailboxArgs(argv: string[]): {
  caller: string | undefined;
  json: boolean;
  flags: Record<string, string | undefined>;
  positionals: string[];
} {
  let rest = [...argv];
  const callerFlag = takeFlag(rest, "--caller");
  rest = callerFlag.rest;
  const json = hasFlag(rest, "--json");
  rest = rest.filter((arg) => arg !== "--json");
  const names = ["--repo", "--target", "--message", "--thread", "--thread-id", "--request-id", "--model", "--effort", "--kind", "--base", "--ref", "--run-id", "--offset", "--limit"] as const;
  const flags: Record<string, string | undefined> = {};
  for (const name of names) {
    const taken = takeFlag(rest, name);
    rest = taken.rest;
    if (taken.value !== undefined) flags[name] = taken.value;
  }
  if (rest.some((arg) => arg.startsWith("-"))) throw new Error(`unknown option: ${rest.find((arg) => arg.startsWith("-"))}`);
  return {
    caller: callerFlag.value !== undefined ? parseCaller(callerFlag.value) : undefined,
    json,
    flags,
    positionals: rest,
  };
}

function writeJson(body: unknown, pretty = true): void {
  process.stdout.write(`${pretty ? JSON.stringify(body, null, 2) : JSON.stringify(body)}\n`);
}

const HELP = `outsrc init [--repo <path>]... [--yes] [--json] [--plugins|--no-plugins] [--local claude,codex,grok]
            [--max-jobs <n|unlimited>] [--max-run-minutes <n|unlimited>]
       config [list] | config set <key> <value> | config unset <key>
       doctor | list_repos | list_targets | targets | threads | prune | migrate
       plugins [--codex <script>] [--grok <script>]
       engines pin <codex-plugin|grok-plugin> <commit|branch|tag>
       send --repo <alias> --target <name> --message <text> [--caller <id>] [--json]
            [--thread-id <id>] [--request-id <id>] [--model <m>] [--effort <e>]
            [--kind task|review|adversarial_review] [--base <ref>] [--ref <ref>]
       inbox <thread_id> [--caller <id>] [--json]
       history <thread_id> [--caller <id>] [--json]
       log <thread_id> [--run-id <id>] [--offset <n>] [--limit <n>] [--caller <id>] [--json]
       diff <thread_id> [--limit <n>] [--caller <id>] [--json]
       stop <thread_id> [--caller <id>] [--json]
       discard <thread_id> [--caller <id>] [--json]
       streams [--thread <id>] [--port <n>] [--recent-minutes <n>] [--no-open]   (alias: watch)

init sets up config and optional local MCP registration for local CLIs.
Public install is the Outsrc bot from Bot Exchange; this CLI is for bot authors and advanced operators.

streams opens a local browser grid of live run.log tails, one pane per working thread. It only reads
files under the outsrc home; it never calls a vendor CLI or a model. See outsrc streams --help.

Mailbox commands print JSON (same shapes as the stdio MCP tools). Pass --caller so each
bot only sees its own threads; omit it on doctor/list_*/threads to act as the owner.
`;

const STREAMS_HELP = `outsrc streams [--thread <id>] [--port <n>] [--recent-minutes <n>] [--no-open]
outsrc watch   (same command)

Serves a grid of live run logs on http://127.0.0.1 and opens it in your browser.
One pane per working thread: short id, target, status, branch and age, then the tail of the
latest run's run.log. Panes follow new output; scroll up to pause, click "paused" to follow again.
New threads appear without a restart. Finished threads stop growing and move to a muted strip
(click one to show its log). Threads finished more than --recent-minutes ago (default 15) are hidden.

  --thread <id>          Show only this thread, finished or not; waits for it if it does not exist yet
  --port <n>             Listen on this port (default: a free one)
  --recent-minutes <n>   How long finished threads stay in the strip (default 15)
  --no-open              Print the URL without opening a browser

The viewer reads $OUTSRC_HOME/threads (default ~/.outsrc) about once a second, only while a page is
open. It never calls a vendor CLI or a model and writes nothing. The URL carries a random token and
the server listens on 127.0.0.1 only. Ctrl-C stops the viewer; jobs keep running.
`;

function openBrowser(url: string): void {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try { spawn(opener, [url], { detached: true, stdio: "ignore" }).on("error", () => {}).unref(); } catch { /* the URL is printed anyway */ }
}

async function runStreams(argv: string[]): Promise<void> {
  if (hasFlag(argv, "--help") || hasFlag(argv, "-h")) { process.stdout.write(STREAMS_HELP); return; }
  let rest = argv.filter((arg) => arg !== "--no-open");
  const thread = takeFlag(rest, "--thread"); rest = thread.rest;
  const port = takeFlag(rest, "--port"); rest = port.rest;
  const recent = takeFlag(rest, "--recent-minutes"); rest = recent.rest;
  if (rest.length) throw new Error(`unknown argument: ${rest[0]}\n\n${STREAMS_HELP}`);
  const portNumber = port.value === undefined ? 0 : Number(port.value);
  if (!Number.isInteger(portNumber) || portNumber < 0 || portNumber > 65535) throw new Error("--port must be 0-65535");
  const recentMinutes = recent.value === undefined ? 15 : Number(recent.value);
  if (!Number.isFinite(recentMinutes) || recentMinutes < 0) throw new Error("--recent-minutes must be a number of minutes");
  const server = await startStreamServer({
    home: defaultHome(), port: portNumber, recentMs: recentMinutes * 60_000,
    ...(thread.value !== undefined ? { thread: parseThreadId(thread.value) } : {}),
  });
  process.stdout.write(`outsrc streams: ${server.url}\nWatching ${defaultHome()}/threads. Ctrl-C stops the viewer; jobs keep running.\n`);
  if (!hasFlag(argv, "--no-open")) openBrowser(server.url);
  await new Promise<void>((resolve) => {
    const stop = () => { void server.close().then(resolve); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

const command = process.argv[2] ?? "help";
try {
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
  } else if (command === "streams" || command === "watch") {
    await runStreams(process.argv.slice(3));
  } else if (command === "init") {
    const options = parseInitArgs(process.argv.slice(3));
    const env = defaultInitEnv(defaultConfigPath(defaultHome()), options.json);
    try { process.exitCode = await runInit(env, options); }
    finally { env.close(); }
  } else if (command === "engines") {
    const [sub, adapter, ref] = process.argv.slice(3);
    if (sub !== "pin" || !adapter || !isPluginAdapter(adapter) || !ref) throw new Error("usage: outsrc engines pin <codex-plugin|grok-plugin> <commit|branch|tag>");
    const current = readLock()[adapter];
    if (!current) throw new Error(`engines.lock.json has no ${adapter} entry`);
    const commit = resolveCommit(current.source, ref);
    const script = installEngine(defaultHome(), adapter, { ...current, commit });
    const report = checkPluginContract(adapter, script);
    if (report.problems.length) {
      writeJson({ pinned: false, report });
      process.exitCode = 1;
    } else {
      const entry = { ...current, commit, version: pluginVersion(script) ?? "unknown" };
      writeLockEntry(adapter, entry);
      writeJson({ pinned: true, entry, next: "Run npm run smoke:plugins. Commit engines.lock.json if it passes; revert it if not." });
    }
  } else if (command === "config") {
    const [sub, key, value, ...extra] = process.argv.slice(3).filter((arg) => arg !== "--json");
    const configPath = defaultConfigPath(defaultHome());
    if (sub === undefined || sub === "list") writeJson(listSettings(configPath));
    else if ((sub === "set" && key && value !== undefined && extra.length === 0) || (sub === "unset" && key && value === undefined)) {
      const change = changeSetting(configPath, key, sub === "set" ? value : undefined);
      writeJson(change);
      if (!change.ok) process.exitCode = 1;
      else if (change.warning) process.stderr.write(`Note: ${change.warning}\n`);
    } else throw new Error("usage: outsrc config [list] | config set <key> <value> | config unset <key>");
  } else if (command === "plugins") {
    const flags = process.argv.slice(3);
    const codex = flagValue(flags, "--codex");
    const grok = flagValue(flags, "--grok");
    const reports = pluginReports({ ...(codex ? { "codex-plugin": codex } : {}), ...(grok ? { "grok-plugin": grok } : {}) });
    writeJson({ plugins: reports });
    if (reports.length === 0 || reports.some((report) => report.status !== "ok")) process.exitCode = 1;
  } else {
    const home = defaultHome();
    const config = loadConfigFile(defaultConfigPath(home));
    const parsed = parseMailboxArgs(process.argv.slice(3));
    // Owner CLI (no --caller) sees every thread for doctor/list/threads/prune.
    // Mailbox mutations and per-thread reads default to "local" when --caller is omitted.
    const ownerCommands = new Set(["doctor", "list_repos", "repos", "list_targets", "targets", "threads", "prune", "migrate"]);
    const caller = parsed.caller ?? (ownerCommands.has(command) ? undefined : DEFAULT_CALLER);
    const box = createMailbox({ home, config, ...(caller !== undefined ? { caller } : {}) });

    switch (command) {
      case "doctor": {
        const targets = box.listTargets().targets;
        const plugins = Object.values(config.targets).flatMap((target) =>
          target.adapter && isPluginAdapter(target.adapter) && target.command ? [checkPluginContract(target.adapter, target.command)] : []);
        const report = {
          node: process.version,
          config: defaultConfigPath(home),
          repositories: box.listRepos().repos,
          targets,
          plugins,
          note: "Checks configuration, executable discovery and the vendor plugin CLI contract. Does not authenticate providers or establish an execution security boundary.",
        };
        writeJson(report);
        if (targets.some((target) => !target.available) || plugins.some((plugin) => plugin.status === "broken")) process.exitCode = 1;
        break;
      }
      case "list_repos":
      case "repos":
        writeJson(box.listRepos());
        break;
      case "list_targets":
      case "targets":
        writeJson(box.listTargets());
        break;
      case "threads":
        writeJson(box.threads());
        break;
      case "migrate": {
        const migrated = migrateLegacy({ home, config });
        writeJson(migrated);
        if (migrated.skipped.length) process.exitCode = 1;
        break;
      }
      case "prune":
        writeJson(box.prune());
        break;
      case "send": {
        const message = parsed.flags["--message"] ?? parsed.positionals[0];
        if (!message) throw new Error("send needs --message <text>");
        const kind = parsed.flags["--kind"];
        const threadId = parsed.flags["--thread-id"] ?? parsed.flags["--thread"];
        const input: SendInput = {
          message,
          ...(parsed.flags["--repo"] !== undefined ? { repo: parsed.flags["--repo"] } : {}),
          ...(parsed.flags["--target"] !== undefined ? { target: parsed.flags["--target"] } : {}),
          ...(threadId !== undefined ? { thread_id: threadId } : {}),
          ...(parsed.flags["--request-id"] !== undefined ? { request_id: parsed.flags["--request-id"] } : {}),
          ...(parsed.flags["--model"] !== undefined ? { model: parsed.flags["--model"] } : {}),
          ...(parsed.flags["--effort"] !== undefined ? { effort: parsed.flags["--effort"] } : {}),
          ...(kind === "task" || kind === "review" || kind === "adversarial_review" ? { kind } : {}),
          ...(parsed.flags["--base"] !== undefined ? { base: parsed.flags["--base"] } : {}),
          ...(parsed.flags["--ref"] !== undefined ? { ref: parsed.flags["--ref"] } : {}),
        };
        const sent = await box.send(input);
        if (sent.ok) writeJson({ delivered: true, thread_id: sent.thread_id, run_id: sent.run_id });
        else {
          writeJson(sent);
          process.exitCode = 1;
        }
        break;
      }
      case "inbox": {
        const threadId = parsed.positionals[0] ?? parsed.flags["--thread-id"] ?? parsed.flags["--thread"];
        if (!threadId) throw new Error("inbox needs <thread_id>");
        const result = box.inbox(threadId);
        writeJson(result);
        if (!result.ok) process.exitCode = 1;
        break;
      }
      case "history": {
        const threadId = parsed.positionals[0] ?? parsed.flags["--thread-id"] ?? parsed.flags["--thread"];
        if (!threadId) throw new Error("history needs <thread_id>");
        const result = box.history(threadId);
        writeJson(result);
        if (!result.ok) process.exitCode = 1;
        break;
      }
      case "log": {
        const threadId = parsed.positionals[0] ?? parsed.flags["--thread-id"] ?? parsed.flags["--thread"];
        if (!threadId) throw new Error("log needs <thread_id>");
        const offset = parsed.flags["--offset"] !== undefined ? Number(parsed.flags["--offset"]) : undefined;
        const limit = parsed.flags["--limit"] !== undefined ? Number(parsed.flags["--limit"]) : undefined;
        if (offset !== undefined && !Number.isFinite(offset)) throw new Error("--offset must be a number");
        if (limit !== undefined && !Number.isFinite(limit)) throw new Error("--limit must be a number");
        const result = box.log({
          thread_id: threadId,
          ...(parsed.flags["--run-id"] !== undefined ? { run_id: parsed.flags["--run-id"] } : {}),
          ...(offset !== undefined ? { offset } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
        writeJson(result);
        if (!result.ok) process.exitCode = 1;
        break;
      }
      case "diff": {
        const threadId = parsed.positionals[0] ?? parsed.flags["--thread-id"] ?? parsed.flags["--thread"];
        if (!threadId) throw new Error("diff needs <thread_id>");
        const limit = parsed.flags["--limit"] !== undefined ? Number(parsed.flags["--limit"]) : undefined;
        if (limit !== undefined && !Number.isFinite(limit)) throw new Error("--limit must be a number");
        const result = box.diff({ thread_id: threadId, ...(limit !== undefined ? { limit } : {}) });
        writeJson(result);
        if ("ok" in result && result.ok === false) process.exitCode = 1;
        break;
      }
      case "stop": {
        const threadId = parsed.positionals[0] ?? parsed.flags["--thread-id"] ?? parsed.flags["--thread"];
        if (!threadId) throw new Error("stop needs <thread_id>");
        const result = box.stop(threadId);
        writeJson(result);
        if (!result.ok) process.exitCode = 1;
        break;
      }
      case "discard": {
        const threadId = parsed.positionals[0] ?? parsed.flags["--thread-id"] ?? parsed.flags["--thread"];
        if (!threadId) throw new Error("discard needs <thread_id>");
        const result = box.discard(threadId);
        writeJson(result);
        if (!result.ok) process.exitCode = 1;
        break;
      }
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  const mailbox = new Set(["send", "inbox", "history", "log", "diff", "stop", "discard"]);
  if (mailbox.has(command)) process.stdout.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
  else process.stderr.write(`${message}\n`);
}
