import { z } from "zod";
import { permissionFlags } from "./permissions.js";
import { isPluginAdapter, parsePluginOutput, pluginInvocation, type PluginAdapter } from "./plugins.js";
import type { TaskKind } from "./types.js";

export type Adapter = "claude" | "codex" | "grok" | "custom" | PluginAdapter;

export type AdapterTarget = {
  adapter: Adapter;
  command: string;
  args: string[];
};

export type InvocationOptions = {
  target: AdapterTarget;
  worktree: string;
  prompt: string;
  model: string | null;
  effort: string | null;
  sessionId: string | null;
  schemaPath: string;
  permissions: "auto" | "ask";
  kind: TaskKind;
  base: string | null;
  dataDir: string;
  threadId: string;
};

export const FindingSchema = z.object({
  priority: z.enum(["P0", "P1", "P2", "P3"]),
  title: z.string().min(1),
  body: z.string().min(1),
  path: z.string().nullable(),
  line: z.number().int().positive().nullable(),
});

export type Finding = z.infer<typeof FindingSchema>;

const ResultSchema = z.object({
  kind: z.enum(["completed", "needs_input", "failed"]),
  message: z.string().trim().min(1),
  findings: z.array(FindingSchema),
});

export type AgentOutput = z.infer<typeof ResultSchema> & {
  sessionId: string | null;
};

export const AGENT_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["completed", "needs_input"] },
    message: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          priority: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
          title: { type: "string" },
          body: { type: "string" },
          path: { type: ["string", "null"] },
          line: { type: ["integer", "null"] },
        },
        required: ["priority", "title", "body", "path", "line"],
        additionalProperties: false,
      },
    },
  },
  required: ["kind", "message", "findings"],
  additionalProperties: false,
};

function substitute(args: string[], options: InvocationOptions): string[] {
  const variables = {
    worktree: options.worktree,
    model: options.model ?? "",
    effort: options.effort ?? "",
    session_id: options.sessionId ?? "",
    schema: options.schemaPath,
  };
  return args.map((arg) => {
    let value = arg;
    for (const [name, replacement] of Object.entries(variables)) {
      value = value.replaceAll(`{${name}}`, replacement);
    }
    return value;
  });
}

function nativeArgs(adapter: "claude" | "codex" | "grok", args: string[]): string[] {
  const values = new Set([
    "--model", "-m", "--effort", "--reasoning-effort", "--output-format",
    "--json-schema", "--output-schema", "--resume", "-r",
  ]);
  const result: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (values.has(arg)) {
      index++;
      continue;
    }
    if ([...values].some((flag) => arg.startsWith(`${flag}=`))) continue;
    if (adapter === "codex") {
      if (index === 0 && arg === "exec") continue;
      if (arg === "--json") continue;
      if ((arg === "-c" || arg === "--config") &&
          /^(model_reasoning_effort|model_service_tier)=/.test(args[index + 1] ?? "")) {
        index++;
        continue;
      }
    } else if (arg === "-p" || arg === "--print" || arg === "--single") {
      if (adapter === "grok" && args[index + 1] && !args[index + 1]?.startsWith("-")) index++;
      continue;
    }
    result.push(arg);
  }
  return result;
}

export function buildInvocation(options: InvocationOptions): { command: string; args: string[]; env?: Record<string, string> } {
  const { target, model, effort, sessionId, prompt } = options;
  // Review and adversarial_review are always read-only, whatever the target's permissions setting.
  const effectivePermissions = options.kind === "task" ? options.permissions : "ask";
  if (isPluginAdapter(target.adapter)) {
    return pluginInvocation(target.adapter, {
      script: target.command, worktree: options.worktree, prompt, model, effort, sessionId,
      kind: options.kind, base: options.base, permissions: effectivePermissions,
      dataDir: options.dataDir, threadId: options.threadId,
    });
  }
  const adapter = target.adapter;
  const configured = substitute(target.args, options);
  if (adapter === "custom") {
    if (sessionId && !target.args.some((arg) => arg.includes("{session_id}"))) {
      throw new Error("custom adapter cannot resume without a {session_id} argument");
    }
    return {
      command: target.command,
      args: [...configured, ...permissionFlags(target.command, configured, effectivePermissions), prompt],
    };
  }

  const extra = nativeArgs(adapter, configured);
  const permissions = permissionFlags(target.command, extra, effectivePermissions);
  const modelArgs = model === null ? [] : ["--model", model];
  switch (adapter) {
    case "claude":
      return {
        command: target.command,
        args: [
          ...extra, "-p", "--output-format", "json", "--json-schema", JSON.stringify(AGENT_OUTPUT_SCHEMA),
          ...modelArgs, ...(effort === null ? [] : ["--effort", effort]),
          ...(sessionId === null ? [] : ["--resume", sessionId]), ...permissions,
          // A review reads someone else's branch: load only the user's own settings, and no MCP servers.
          ...(options.kind === "task" ? [] : ["--setting-sources", "user", "--strict-mcp-config"]), "--", prompt,
        ],
      };
    case "codex": {
      const configuration = [
        "-c", "model_service_tier=fast",
        ...(effort === null ? [] : ["-c", `model_reasoning_effort=${effort}`]),
      ];
      const output = ["--json", "--output-schema", options.schemaPath, ...modelArgs];
      return {
        command: target.command,
        args: [
          "exec", ...extra, ...configuration, ...permissions,
          ...(sessionId === null ? output : ["resume", ...output, sessionId]),
          "--", prompt,
        ],
      };
    }
    case "grok":
      return {
        command: target.command,
        args: [
          ...extra, "--output-format", "json", "--json-schema", JSON.stringify(AGENT_OUTPUT_SCHEMA),
          ...modelArgs, ...(effort === null ? [] : ["--reasoning-effort", effort]),
          ...(sessionId === null ? [] : ["--resume", sessionId]), ...permissions,
          ...(prompt.startsWith("-") ? [`--single=${prompt}`] : ["-p", prompt]),
        ],
      };
    default: {
      const exhaustive: never = adapter;
      throw new Error(`unknown adapter: ${exhaustive}`);
    }
  }
}

const EnvelopeSchema = z.object({
  type: z.string().optional(),
  session_id: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  structured_output: z.unknown().optional(),
  structuredOutput: z.unknown().optional(),
  result: z.string().optional(),
  text: z.string().optional(),
  is_error: z.boolean().optional(),
  errors: z.array(z.string()).optional(),
  message: z.unknown().optional(),
});

const CodexEventSchema = z.object({
  type: z.string(),
  thread_id: z.string().min(1).optional(),
  message: z.string().optional(),
  error: z.object({ message: z.string() }).optional(),
  item: z.object({ type: z.string(), text: z.string().optional() }).optional(),
});

function failed(message: string, sessionId: string | null = null): AgentOutput {
  return { kind: "failed", message, sessionId, findings: [] };
}

export function parseAgentOutput(input: {
  adapter: Adapter;
  stdout: string;
  exitCode: number | null;
}): AgentOutput {
  if (isPluginAdapter(input.adapter)) return parsePluginOutput(input.stdout, input.exitCode);
  let sessionId: string | null = null;
  try {
    let value: unknown;
    if (input.adapter === "codex") {
      let finalText: string | undefined;
      let complete = false;
      for (const line of input.stdout.trim().split("\n").filter((line) => line.trim())) {
        const event = CodexEventSchema.parse(JSON.parse(line));
        if (event.type === "thread.started") sessionId = event.thread_id ?? sessionId;
        if (event.type === "turn.failed" || event.type === "error") {
          return failed(event.error?.message ?? event.message ?? "Codex turn failed", sessionId);
        }
        if (event.type === "item.completed" && event.item?.type === "agent_message") {
          finalText = event.item.text;
        }
        if (event.type === "turn.completed") complete = true;
      }
      if (!complete || !finalText) {
        const message = input.exitCode === 0 ? "Codex did not return a completed turn" :
          `Agent process exited with ${input.exitCode ?? "a signal"} before completing Codex turn`;
        return failed(message, sessionId);
      }
      value = JSON.parse(finalText);
    } else if (input.adapter === "custom") {
      const custom = ResultSchema.extend({ sessionId: z.string().min(1).nullable() }).parse(JSON.parse(input.stdout));
      sessionId = custom.sessionId;
      value = custom;
    } else {
      const raw: unknown = JSON.parse(input.stdout);
      const messages = z.array(EnvelopeSchema).safeParse(raw);
      const envelope = messages.success ? messages.data.findLast((message) => message.type === "result") : EnvelopeSchema.parse(raw);
      if (!envelope) return failed("Agent output did not include a final result", sessionId);
      sessionId = envelope.session_id ?? envelope.sessionId ?? null;
      if (envelope.is_error || envelope.type === "error") {
        const message = typeof envelope.message === "string" ? envelope.message : "Agent reported an error";
        return failed(envelope.errors?.join("\n") || envelope.result || message, sessionId);
      }
      value = envelope.structured_output ?? envelope.structuredOutput;
      if (value === undefined && input.adapter === "grok" && envelope.text) {
        value = JSON.parse(envelope.text);
      }
    }
    if (input.exitCode !== 0) return failed(`Agent process exited with ${input.exitCode ?? "a signal"}`, sessionId);
    const result = ResultSchema.parse(value);
    if (result.kind === "needs_input" && sessionId === null) {
      return failed("Agent requested input without a resumable session ID", sessionId);
    }
    return { ...result, sessionId };
  } catch {
    if (input.exitCode !== 0) {
      return failed(`Agent process exited with ${input.exitCode ?? "a signal"} without valid ${input.adapter} output`, sessionId);
    }
    return failed(`Invalid ${input.adapter} agent output`, sessionId);
  }
}
