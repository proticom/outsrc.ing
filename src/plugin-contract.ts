import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { LOCK_FILE, readLock } from "./engines.js";
import { ENGINES, realScript, type PluginAdapter } from "./plugins.js";

export type ContractStatus = "ok" | "unverified" | "broken";
export type ContractReport = {
  adapter: PluginAdapter;
  script: string;
  version: string | null;
  status: ContractStatus;
  problems: string[];
};

export function pluginVersion(script: string): string | null {
  const manifest = join(dirname(dirname(script)), ".claude-plugin", "plugin.json");
  if (!existsSync(manifest)) return null;
  const parsed = z.object({ version: z.string() }).safeParse(JSON.parse(readFileSync(manifest, "utf8")));
  return parsed.success ? parsed.data.version : null;
}

export function isVerified(adapter: PluginAdapter, version: string | null, file = LOCK_FILE): boolean {
  return version !== null && readLock(file)[adapter]?.version === version;
}

function sources(directory: string): string {
  return readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".mjs"))
    .map((name) => readFileSync(join(directory, name), "utf8"))
    .join("\n");
}

// Checks the parts of the plugin's CLI outsrc depends on without running a model.
export function checkPluginContract(adapter: PluginAdapter, requested: string, lockFile = LOCK_FILE): ContractReport {
  const engine = ENGINES[adapter];
  const script = realScript(requested);
  const version = pluginVersion(script);
  const problems: string[] = [];
  if (!existsSync(script)) {
    return { adapter, script, version, status: "broken", problems: [`engine script not found: ${script}`] };
  }

  const help = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8", timeout: 30_000 });
  const usage = `${help.stdout}\n${help.stderr}`.split("\n");
  for (const [subcommand, flags] of Object.entries(engine.usage)) {
    const line = usage.find((text) => new RegExp(`\\.mjs ${subcommand}(\\s|$)`).test(text));
    if (!line) { problems.push(`--help no longer lists the ${subcommand} subcommand`); continue; }
    for (const flag of flags) {
      if (!new RegExp(`${flag}(?![\\w-])`).test(line)) problems.push(`${subcommand} no longer lists ${flag}`);
    }
  }

  const code = sources(dirname(script));
  for (const name of [engine.sessionEnv, "CLAUDE_PLUGIN_DATA", "rawOutput", "threadId"]) {
    if (!code.includes(name)) problems.push(`engine source no longer mentions ${name}`);
  }
  if (engine.teardownHook) {
    const hook = join(dirname(dirname(script)), engine.teardownHook);
    if (!existsSync(hook) || !readFileSync(hook, "utf8").includes("SessionEnd")) problems.push(`teardown hook missing or no longer handles SessionEnd: ${engine.teardownHook}`);
  }

  const scratch = mkdtempSync(join(tmpdir(), "outsrc-contract-"));
  try {
    const repo = join(scratch, "repo");
    spawnSync("git", ["init", "-q", repo]);
    const probe = spawnSync(process.execPath, [script, engine.status, "--json", "--cwd", repo], {
      encoding: "utf8",
      timeout: 30_000,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", CLAUDE_PLUGIN_DATA: join(scratch, "data"), [engine.sessionEnv]: "outsrc-contract" },
    });
    try {
      const status = z.object({ workspaceRoot: z.string() }).parse(JSON.parse(probe.stdout));
      if (!status.workspaceRoot.endsWith("repo")) problems.push(`${engine.status} --cwd did not use the requested directory`);
    } catch {
      problems.push(`${engine.status} --json --cwd did not return the expected JSON (exit ${probe.status ?? "signal"})`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const status: ContractStatus = problems.length ? "broken" : isVerified(adapter, version, lockFile) ? "ok" : "unverified";
  return { adapter, script, version, status, problems };
}
