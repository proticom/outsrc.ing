import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { z } from "zod";
import type { Adapter } from "./adapters.js";

export type ModelOptions = { default: string; allowed: string[] };
type Lister = { command: string; args: string[]; input?: string; parse: (stdout: string) => ModelOptions | null };

const ClaudeInit = z.object({
  type: z.literal("control_response"),
  response: z.object({
    subtype: z.literal("success"),
    response: z.object({ models: z.array(z.object({ value: z.string().min(1), resolvedModel: z.string().min(1).optional() })) }),
  }),
});

// The Agent SDK's supportedModels(): the initialize control response lists every --model value the account can use.
// The "default" entry names the account default; a model set in the user's own settings still wins at run time.
export function parseClaudeModels(stdout: string): ModelOptions | null {
  for (const line of stdout.split("\n")) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    const init = ClaudeInit.safeParse(value);
    if (!init.success) continue;
    const models = init.data.response.response.models;
    const fallback = models.find((model) => model.value === "default")?.resolvedModel;
    const allowed = [...new Set(models.map((model) => model.value).filter((name) => name !== "default"))];
    if (!fallback || allowed.length === 0) return null;
    return { default: fallback, allowed: allowed.includes(fallback) ? allowed : [fallback, ...allowed] };
  }
  return null;
}

const CodexCatalog = z.object({
  models: z.array(z.object({ slug: z.string().min(1), visibility: z.string(), priority: z.number() })),
});

// Codex's own picker shows the "list" models and defaults to the highest priority one, as app-server model/list reports.
export function parseCodexModels(stdout: string): ModelOptions | null {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { return null; }
  const catalog = CodexCatalog.safeParse(value);
  if (!catalog.success) return null;
  const listed = catalog.data.models.filter((model) => model.visibility === "list").sort((a, b) => a.priority - b.priority);
  const first = listed[0];
  return first ? { default: first.slug, allowed: listed.map((model) => model.slug) } : null;
}

// `grok models` has no JSON mode. It prints "Available models:" then one "* id (default)" or "- id" line per model.
export function parseGrokModels(stdout: string): ModelOptions | null {
  const lines = stdout.split("\n");
  const start = lines.findIndex((line) => /^available models:/i.test(line.trim()));
  if (start < 0) return null;
  const allowed: string[] = [];
  let fallback: string | undefined;
  for (const line of lines.slice(start + 1)) {
    const match = /^\s*[*-]\s+(\S+)(\s+\(default\))?\s*$/.exec(line);
    if (!match?.[1]) continue;
    allowed.push(match[1]);
    if (match[2]) fallback = match[1];
  }
  fallback ??= /^default model:\s*(\S+)/im.exec(stdout)?.[1];
  return fallback && allowed.includes(fallback) ? { default: fallback, allowed } : null;
}

const CLAUDE_INIT = `${JSON.stringify({ type: "control_request", request_id: "outsrc-models", request: { subtype: "initialize" } })}\n`;

// Plugin engines run the vendor CLI themselves: the Codex companion spawns `codex` from PATH, the Grok bridge
// `$GROK_BINARY` or `grok`. Neither engine has a model-list subcommand, so outsrc asks the CLI they run.
function lister(adapter: Adapter, command: string): Lister | null {
  switch (adapter) {
    case "claude":
      return {
        command,
        args: ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence",
          "--setting-sources", "user", "--strict-mcp-config", "--settings", JSON.stringify({ disableAllHooks: true })],
        input: CLAUDE_INIT,
        parse: parseClaudeModels,
      };
    case "codex": return { command, args: ["debug", "models"], parse: parseCodexModels };
    case "codex-plugin": return { command: "codex", args: ["debug", "models"], parse: parseCodexModels };
    case "grok": return { command, args: ["models"], parse: parseGrokModels };
    case "grok-plugin": return { command: process.env.GROK_BINARY ?? "grok", args: ["models"], parse: parseGrokModels };
    // A custom target's command has no known listing contract.
    case "custom": return null;
    default: {
      const exhaustive: never = adapter;
      throw new Error(`unknown adapter: ${exhaustive}`);
    }
  }
}

/** Asks the target's CLI which models it can use. Null when the adapter cannot list or the CLI fails. */
export function discoverModels(adapter: Adapter, command: string): ModelOptions | null {
  const plan = lister(adapter, command);
  if (!plan || !plan.command) return null;
  const result = spawnSync(plan.command, plan.args, {
    cwd: tmpdir(), encoding: "utf8", timeout: 30_000, stdio: ["pipe", "pipe", "ignore"], input: plan.input ?? "",
  });
  if (result.error || result.status !== 0) return null;
  return plan.parse(result.stdout);
}
