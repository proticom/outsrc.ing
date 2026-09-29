import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { AgentOutput, Finding } from "./adapters.js";
import type { PermissionMode, TaskKind } from "./types.js";

export type PluginAdapter = "codex-plugin" | "grok-plugin";

type Engine = {
  pluginKey: string;
  script: string;
  sessionEnv: string;
  task: string;
  review: string;
  adversarial: string;
  cancel: string;
  status: string;
  reviewTakesModel: boolean;
  teardownHook: string | null;
  // Subcommand -> flags outsrc passes, as listed in the engine's --help usage.
  usage: Record<string, string[]>;
};

const TASK_FLAGS = ["--write", "--resume-last", "--fresh", "--model", "--effort"];

// The subcommands and environment names are the vendor plugins' own CLI contract:
// openai/codex-plugin-cc scripts/codex-companion.mjs and xai-org/grok-build-plugin-cc scripts/grok-bridge.mjs.
export const ENGINES: Record<PluginAdapter, Engine> = {
  "codex-plugin": {
    pluginKey: "codex@openai-codex",
    script: "scripts/codex-companion.mjs",
    sessionEnv: "CODEX_COMPANION_SESSION_ID",
    task: "task",
    review: "review",
    adversarial: "adversarial-review",
    cancel: "cancel",
    status: "status",
    reviewTakesModel: false,
    // Codex keeps an app-server broker alive until Claude Code's SessionEnd hook stops it.
    teardownHook: "scripts/session-lifecycle-hook.mjs",
    usage: { task: TASK_FLAGS, review: ["--wait", "--base", "--scope"], "adversarial-review": ["--wait", "--base", "--scope"], cancel: [] },
  },
  "grok-plugin": {
    pluginKey: "grok-build@xai-grok-build",
    script: "scripts/grok-bridge.mjs",
    sessionEnv: "GROK_CC_SESSION_ID",
    task: "run",
    review: "review",
    adversarial: "critique",
    cancel: "stop",
    status: "runs",
    reviewTakesModel: true,
    teardownHook: null,
    usage: {
      run: TASK_FLAGS,
      review: ["--wait", "--base", "--scope", "--model", "--effort"],
      critique: ["--wait", "--base", "--scope", "--model", "--effort"],
      stop: [],
    },
  },
};

export function isPluginAdapter(adapter: string): adapter is PluginAdapter {
  return adapter === "codex-plugin" || adapter === "grok-plugin";
}

const InstalledSchema = z.object({
  plugins: z.record(z.string(), z.array(z.object({ installPath: z.string() }))),
});

export function resolvePluginScript(adapter: PluginAdapter, claudeDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")): string | null {
  const file = join(claudeDir, "plugins", "installed_plugins.json");
  if (!existsSync(file)) return null;
  const parsed = InstalledSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) return null;
  const install = parsed.data.plugins[ENGINES[adapter].pluginKey]?.at(-1);
  if (!install) return null;
  const script = join(install.installPath, ENGINES[adapter].script);
  return existsSync(script) ? realScript(script) : null;
}

// grok-bridge.mjs compares its real path with argv[1] before running, so a symlinked path exits 0 silently.
export function realScript(script: string): string {
  return existsSync(script) ? realpathSync(script) : script;
}

export function engineDir(threadDirectory: string, adapter: PluginAdapter): string {
  return join(threadDirectory, "engine", adapter);
}

type Invocation = { command: string; args: string[]; env: Record<string, string>; input?: string };

function engineEnv(adapter: PluginAdapter, dataDir: string, sessionKey: string): Record<string, string> {
  return { CLAUDE_PLUGIN_DATA: dataDir, [ENGINES[adapter].sessionEnv]: sessionKey };
}

export function pluginInvocation(adapter: PluginAdapter, options: {
  script: string;
  worktree: string;
  prompt: string;
  model: string | null;
  effort: string | null;
  sessionId: string | null;
  kind: TaskKind;
  base: string | null;
  permissions: PermissionMode;
  dataDir: string;
  threadId: string;
}): Invocation {
  const engine = ENGINES[adapter];
  const model = [
    ...(options.model === null ? [] : ["--model", options.model]),
    ...(options.effort === null ? [] : ["--effort", options.effort]),
  ];
  const where = ["--json", "--cwd", options.worktree];
  let args: string[];
  if (options.kind !== "task" && options.base !== null) {
    // Review kinds are always read-only at the plugin argv layer; do not pass --write.
    args = [
      options.kind === "review" ? engine.review : engine.adversarial,
      "--wait", ...where, "--scope", "branch", "--base", options.base,
      ...(engine.reviewTakesModel ? model : []),
      ...(options.kind === "adversarial_review" ? ["--", options.prompt] : []),
    ];
  } else {
    // Force read-only for review / adversarial_review regardless of target permissions.
    const write = options.kind === "task" && options.permissions === "auto";
    args = [
      engine.task, ...where, ...model, ...(write ? ["--write"] : []),
      options.sessionId === null ? "--fresh" : "--resume-last", "--", options.prompt,
    ];
  }
  return {
    command: process.execPath,
    args: [options.script, ...args],
    env: engineEnv(adapter, options.dataDir, options.threadId),
  };
}

export function cancelInvocation(adapter: PluginAdapter, script: string, worktree: string, dataDir: string, threadId: string): Invocation {
  return {
    command: process.execPath,
    args: [script, ENGINES[adapter].cancel, "--json", "--cwd", worktree],
    env: engineEnv(adapter, dataDir, threadId),
  };
}

export function teardownInvocation(adapter: PluginAdapter, script: string, worktree: string, dataDir: string): Invocation | null {
  const hook = ENGINES[adapter].teardownHook;
  if (hook === null) return null;
  return {
    command: process.execPath,
    args: [join(dirname(dirname(script)), hook), "SessionEnd"],
    env: { CLAUDE_PLUGIN_DATA: dataDir },
    // A session id that owns no jobs stops the broker without deleting the job records --resume-last reads.
    input: JSON.stringify({ cwd: worktree, session_id: "outsrc-broker-teardown" }),
  };
}

const NEEDS_INPUT = /^\s*NEEDS_INPUT:\s*/;

const TaskPayload = z.object({
  status: z.number(),
  threadId: z.string().nullable().optional(),
  rawOutput: z.string().optional(),
});
const ReviewFinding = z.object({
  severity: z.enum(["critical", "high", "medium", "low"]),
  title: z.string(),
  body: z.string(),
  file: z.string().nullable().optional(),
  line_start: z.number().int().nullable().optional(),
  recommendation: z.string().nullable().optional(),
});
const EngineRun = z.object({ status: z.number(), stderr: z.string().optional(), stdout: z.string().optional() });
const ReviewResult = z.object({
  verdict: z.string(),
  summary: z.string(),
  findings: z.array(ReviewFinding),
  next_steps: z.array(z.string()).optional(),
});
// Grok Build plugin 0.2.0 stores Grok's whole response envelope as result, with the review as a JSON string in text.
const EnvelopedResult = z.object({ text: z.string() }).transform((envelope, context) => {
  try { return ReviewResult.parse(JSON.parse(envelope.text)); }
  catch { context.addIssue({ code: "custom", message: "result.text is not a review" }); return z.NEVER; }
});
const ReviewPayload = z.object({
  review: z.string(),
  codex: EngineRun.optional(),
  grok: EngineRun.optional(),
  result: z.union([ReviewResult, EnvelopedResult]).nullable().optional(),
  parseError: z.string().nullable().optional(),
});

const PRIORITY = { critical: "P0", high: "P1", medium: "P2", low: "P3" } as const;

function finding(item: z.infer<typeof ReviewFinding>): Finding {
  return {
    priority: PRIORITY[item.severity],
    title: item.title,
    body: item.recommendation ? `${item.body}\n\nRecommendation: ${item.recommendation}` : item.body,
    path: item.file ?? null,
    line: item.line_start && item.line_start > 0 ? item.line_start : null,
  };
}

function failed(message: string, sessionId: string | null = null): AgentOutput {
  return { kind: "failed", message, sessionId, findings: [] };
}

export function parsePluginOutput(stdout: string, exitCode: number | null): AgentOutput {
  let raw: unknown;
  try { raw = JSON.parse(stdout); }
  catch { return failed(`Plugin engine exited with ${exitCode ?? "a signal"} without JSON output; see log`); }

  const review = ReviewPayload.safeParse(raw);
  if (review.success) {
    const engine = review.data.codex ?? review.data.grok;
    if (!engine || engine.status !== 0) {
      return failed(engine?.stderr?.trim() || review.data.parseError || `${review.data.review} failed`);
    }
    const result = review.data.result;
    if (!result) {
      const text = engine.stdout?.trim();
      return text ? { kind: "completed", message: text, sessionId: null, findings: [] } : failed(`${review.data.review} returned no output`);
    }
    const steps = result.next_steps?.length ? `\n\nNext steps:\n${result.next_steps.map((step) => `- ${step}`).join("\n")}` : "";
    return {
      kind: "completed",
      message: `Verdict: ${result.verdict}\n\n${result.summary}${steps}`,
      sessionId: null,
      findings: result.findings.map(finding),
    };
  }

  const task = TaskPayload.safeParse(raw);
  if (!task.success) return failed("Plugin engine returned an unrecognized JSON payload");
  const sessionId = task.data.threadId ?? null;
  const text = task.data.rawOutput?.trim() ?? "";
  if (task.data.status !== 0 || exitCode !== 0) {
    return failed(text || `Plugin engine exited with ${exitCode ?? "a signal"}; see log`, sessionId);
  }
  if (!text) return failed("Plugin engine returned an empty final message", sessionId);
  if (NEEDS_INPUT.test(text)) {
    if (sessionId === null) return failed("Agent requested input without a resumable session ID");
    return { kind: "needs_input", message: text.replace(NEEDS_INPUT, "").trim(), sessionId, findings: [] };
  }
  return { kind: "completed", message: text, sessionId, findings: [] };
}
