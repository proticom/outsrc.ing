import { describe, expect, test } from "vitest";
import {
  AGENT_OUTPUT_SCHEMA,
  buildInvocation,
  parseAgentOutput,
  type Adapter,
  type InvocationOptions,
} from "../src/adapters.ts";

function invocation(adapter: Adapter, changes: Partial<InvocationOptions> = {}) {
  return buildInvocation({
    target: { adapter, command: adapter, args: [] },
    worktree: "/tmp/project",
    prompt: "Find the failing calculation.",
    model: "chosen-model",
    effort: "high",
    sessionId: null,
    schemaPath: "/tmp/run/result.schema.json",
    permissions: "ask",
    kind: "task",
    base: null,
    dataDir: "",
    threadId: "0123456789abcdef",
    ...changes,
  });
}

describe("native CLI invocation", () => {
  test("review kinds force read-only even when the target permissions are auto", () => {
    const result = invocation("claude", { kind: "review", permissions: "auto" });
    expect(result.args).not.toContain("--permission-mode");
    expect(result.args).not.toContain("bypassPermissions");
    const grok = invocation("grok", { kind: "adversarial_review", permissions: "auto" });
    expect(grok.args).not.toContain("--always-approve");
  });

  test("a Claude review loads only the user's settings and no MCP servers", () => {
    expect(invocation("claude", { kind: "review", permissions: "auto" }).args).toEqual([
      "-p", "--output-format", "json", "--json-schema", JSON.stringify(AGENT_OUTPUT_SCHEMA),
      "--model", "chosen-model", "--effort", "high",
      "--setting-sources", "user", "--strict-mcp-config", "--", "Find the failing calculation.",
    ]);
  });

  test("Claude gets native model, effort, structured output, and session continuation", () => {
    const result = invocation("claude", { sessionId: "claude-session" });
    expect(result).toEqual({
      command: "claude",
      args: [
        "-p", "--output-format", "json", "--json-schema", JSON.stringify(AGENT_OUTPUT_SCHEMA),
        "--model", "chosen-model", "--effort", "high", "--resume", "claude-session",
        "--", "Find the failing calculation.",
      ],
    });
  });

  test("Codex preserves configured options and fast tier while selecting the effective model", () => {
    const result = invocation("codex", {
      target: {
        adapter: "codex", command: "codex",
        args: ["exec", "-C", "{worktree}", "--sandbox", "workspace-write", "-m", "old-model",
          "-c", "model_reasoning_effort=low", "-c", "model_service_tier=fast"],
      },
    });
    expect(result.args).toEqual([
      "exec", "-C", "/tmp/project", "--sandbox", "workspace-write",
      "-c", "model_service_tier=fast", "-c", "model_reasoning_effort=high",
      "--json", "--output-schema", "/tmp/run/result.schema.json", "--model", "chosen-model",
      "--", "Find the failing calculation.",
    ]);
  });

  test("Codex resumes the exact session with output options accepted by resume", () => {
    expect(invocation("codex", { sessionId: "codex-session" }).args).toEqual([
      "exec", "-c", "model_service_tier=fast", "-c", "model_reasoning_effort=high",
      "resume", "--json", "--output-schema", "/tmp/run/result.schema.json", "--model", "chosen-model",
      "codex-session", "--", "Find the failing calculation.",
    ]);
  });

  test("Grok puts the single-turn prompt immediately after -p", () => {
    const result = invocation("grok", {
      target: { adapter: "grok", command: "grok", args: ["--cwd", "{worktree}", "-p"] },
      sessionId: "grok-session", permissions: "auto",
    });
    expect(result.args).toEqual([
      "--cwd", "/tmp/project", "--output-format", "json", "--json-schema", JSON.stringify(AGENT_OUTPUT_SCHEMA),
      "--model", "chosen-model", "--reasoning-effort", "high", "--resume", "grok-session",
      "--always-approve", "-p", "Find the failing calculation.",
    ]);
  });

  test("absent model and effort use native CLI defaults", () => {
    expect(invocation("codex", { model: null, effort: null }).args).toEqual([
      "exec", "-c", "model_service_tier=fast", "--json", "--output-schema", "/tmp/run/result.schema.json",
      "--", "Find the failing calculation.",
    ]);
  });

  test("a Grok task starting with a bullet remains a prompt value", () => {
    expect(invocation("grok", { prompt: "- Review the total." }).args.at(-1)).toBe(
      "--single=- Review the total.",
    );
  });

  test("custom commands substitute declared parameters and receive the prompt as one argument", () => {
    expect(invocation("custom", {
      target: { adapter: "custom", command: "fixture", args: ["{worktree}", "{model}", "{effort}", "{session_id}", "{schema}"] },
      sessionId: "fixture-session",
    })).toEqual({
      command: "fixture",
      args: ["/tmp/project", "chosen-model", "high", "fixture-session", "/tmp/run/result.schema.json", "Find the failing calculation."],
    });
  });

  test("custom continuation fails explicitly without a session placeholder", () => {
    expect(() => invocation("custom", { sessionId: "fixture-session" })).toThrow(
      "custom adapter cannot resume without a {session_id} argument",
    );
  });
});

describe("native CLI results", () => {
  test("Claude returns the structured final answer instead of progress text", () => {
    expect(parseAgentOutput({
      adapter: "claude", exitCode: 0,
      stdout: JSON.stringify({
        type: "result", subtype: "success", is_error: false, session_id: "claude-session",
        result: "I inspected the calculation.",
        structured_output: {
          kind: "completed", message: "The discount is applied twice.",
          findings: [{ priority: "P1", title: "Apply discount once", body: "The total subtracts the discount in both branches.", path: "src/total.ts", line: 12 }],
        },
      }),
    })).toEqual({
      kind: "completed", message: "The discount is applied twice.", sessionId: "claude-session",
      findings: [{ priority: "P1", title: "Apply discount once", body: "The total subtracts the discount in both branches.", path: "src/total.ts", line: 12 }],
    });
  });

  test("Codex reads the final agent message and keeps the thread ID for continuation", () => {
    const stdout = [
      { type: "thread.started", thread_id: "codex-session" },
      { type: "turn.started" },
      { type: "item.completed", item: { type: "agent_message", text: "I am reading the code." } },
      { type: "item.completed", item: { type: "agent_message", text: '{"kind":"needs_input","message":"Which rounding rule should apply?","findings":[]}' } },
      { type: "turn.completed" },
    ].map((event) => JSON.stringify(event)).join("\n");
    expect(parseAgentOutput({ adapter: "codex", stdout, exitCode: 0 })).toEqual({
      kind: "needs_input", message: "Which rounding rule should apply?", sessionId: "codex-session", findings: [],
    });
  });

  test("Grok captures an ended-turn question with a resumable session", () => {
    expect(parseAgentOutput({
      adapter: "grok", exitCode: 0,
      stdout: JSON.stringify({
        sessionId: "grok-session", stopReason: "end_turn",
        text: '{"kind":"needs_input","message":"Keep the existing rounding rule?","findings":[]}',
      }),
    })).toEqual({
      kind: "needs_input", message: "Keep the existing rounding rule?", sessionId: "grok-session", findings: [],
    });
  });

  test("Grok accepts its structured JSON field", () => {
    expect(parseAgentOutput({
      adapter: "grok", exitCode: 0,
      stdout: JSON.stringify({
        sessionId: "grok-session", structuredOutput: { kind: "completed", message: "No calculation errors found.", findings: [] },
      }),
    })).toEqual({ kind: "completed", message: "No calculation errors found.", sessionId: "grok-session", findings: [] });
  });

  test("custom fixtures provide the same normalized protocol directly", () => {
    expect(parseAgentOutput({
      adapter: "custom", exitCode: 0,
      stdout: '{"kind":"completed","message":"The fixture completed.","sessionId":null,"findings":[]}',
    })).toEqual({ kind: "completed", message: "The fixture completed.", sessionId: null, findings: [] });
  });

  test("vendor errors retain their explanation and session", () => {
    expect(parseAgentOutput({
      adapter: "claude", exitCode: 1,
      stdout: '{"type":"result","is_error":true,"session_id":"claude-session","errors":["Maximum turns reached"]}',
    })).toEqual({ kind: "failed", message: "Maximum turns reached", sessionId: "claude-session", findings: [] });
  });

  test("Claude JSON arrays expose the final error rather than losing its session", () => {
    expect(parseAgentOutput({
      adapter: "claude", exitCode: 1,
      stdout: JSON.stringify([
        { type: "system", subtype: "init", session_id: "claude-session" },
        { type: "assistant", session_id: "claude-session", message: { content: [] } },
        { type: "result", subtype: "success", session_id: "claude-session", is_error: true, result: "Not logged in · Please run /login" },
      ]),
    })).toEqual({ kind: "failed", message: "Not logged in · Please run /login", sessionId: "claude-session", findings: [] });
  });

  test("Claude live JSON array format returns the structured resumed answer", () => {
    expect(parseAgentOutput({
      adapter: "claude", exitCode: 0,
      stdout: JSON.stringify([
        { type: "system", subtype: "init", session_id: "claude-session" },
        { type: "assistant", message: { content: [] }, session_id: "claude-session" },
        { type: "user", message: { content: [] }, session_id: "claude-session" },
        { type: "rate_limit_event", session_id: "claude-session" },
        { type: "result", subtype: "success", session_id: "claude-session", is_error: false,
          structured_output: { kind: "completed", message: "native resume passed", findings: [] },
          result: '{"kind":"completed","message":"native resume passed","findings":[]}' },
      ]),
    })).toEqual({ kind: "completed", message: "native resume passed", sessionId: "claude-session", findings: [] });
  });

  test("Grok startup errors expose the native diagnostic", () => {
    expect(parseAgentOutput({
      adapter: "grok", exitCode: 1,
      stdout: '{"type":"error","message":"Could not create session"}',
    })).toEqual({ kind: "failed", message: "Could not create session", sessionId: null, findings: [] });
  });

  test("an incomplete Codex stream is not successful", () => {
    expect(parseAgentOutput({
      adapter: "codex", exitCode: 0,
      stdout: '{"type":"thread.started","thread_id":"codex-session"}\n{"type":"turn.started"}',
    })).toEqual({ kind: "failed", message: "Codex did not return a completed turn", sessionId: "codex-session", findings: [] });
  });

  test("a nonzero process exit cannot be reported as completed", () => {
    expect(parseAgentOutput({
      adapter: "custom", exitCode: 2,
      stdout: '{"kind":"completed","message":"Partial answer","sessionId":"fixture-session","findings":[]}',
    })).toEqual({ kind: "failed", message: "Agent process exited with 2", sessionId: "fixture-session", findings: [] });
  });

  test("a question without session continuation reports the protocol failure", () => {
    expect(parseAgentOutput({
      adapter: "custom", exitCode: 0,
      stdout: '{"kind":"needs_input","message":"Which version?","sessionId":null,"findings":[]}',
    })).toEqual({ kind: "failed", message: "Agent requested input without a resumable session ID", sessionId: null, findings: [] });
  });

  test("plain output cannot silently satisfy the structured result contract", () => {
    expect(parseAgentOutput({ adapter: "claude", stdout: "Done", exitCode: 0 })).toEqual({
      kind: "failed", message: "Invalid claude agent output", sessionId: null, findings: [],
    });
  });

  test("malformed final output retains the session already announced by Codex", () => {
    expect(parseAgentOutput({
      adapter: "codex", exitCode: 1,
      stdout: '{"type":"thread.started","thread_id":"codex-session"}\ninterrupted output',
    })).toEqual({
      kind: "failed", message: "Agent process exited with 1 without valid codex output", sessionId: "codex-session", findings: [],
    });
  });
});
