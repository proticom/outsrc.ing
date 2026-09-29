import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { buildInvocation, parseAgentOutput, type Adapter, type InvocationOptions } from "../src/adapters.ts";
import { loadConfigFile } from "../src/config.ts";
import { createMailbox } from "../src/mailbox.ts";
import { cancelInvocation, resolvePluginScript, teardownInvocation } from "../src/plugins.ts";
import { initGitRepo, tempHome } from "./helpers.ts";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const FAKE_ENGINE = join(fixtures, "fake-plugin", "scripts", "codex-companion.mjs");
const recorded = (name: string) => readFileSync(join(fixtures, name), "utf8");

function invocation(adapter: Adapter, changes: Partial<InvocationOptions> = {}) {
  return buildInvocation({
    target: { adapter, command: "/plugins/engine.mjs", args: [] },
    worktree: "/tmp/wt",
    prompt: "Fix the parser.",
    model: "m1",
    effort: "low",
    sessionId: null,
    schemaPath: "/tmp/run/schema.json",
    permissions: "auto",
    kind: "task",
    base: null,
    dataDir: "/tmp/thread/engine",
    threadId: "0123456789abcdef",
    ...changes,
  });
}

describe("plugin engine invocation", () => {
  test("a new codex task runs the plugin's task command with write access in the worktree", () => {
    expect(invocation("codex-plugin")).toEqual({
      command: process.execPath,
      args: ["/plugins/engine.mjs", "task", "--json", "--cwd", "/tmp/wt", "--model", "m1", "--effort", "low", "--write", "--fresh", "--", "Fix the parser."],
      env: { CLAUDE_PLUGIN_DATA: "/tmp/thread/engine", CODEX_COMPANION_SESSION_ID: "0123456789abcdef" },
    });
  });

  test("a continuation resumes the plugin's last task in this thread's session", () => {
    expect(invocation("grok-plugin", { sessionId: "vendor-thread" }).args).toEqual(
      ["/plugins/engine.mjs", "run", "--json", "--cwd", "/tmp/wt", "--model", "m1", "--effort", "low", "--write", "--resume-last", "--", "Fix the parser."],
    );
    expect(invocation("grok-plugin").env).toEqual({ CLAUDE_PLUGIN_DATA: "/tmp/thread/engine", GROK_CC_SESSION_ID: "0123456789abcdef" });
  });

  test("review and adversarial_review ignore auto permissions and stay read-only", () => {
    expect(invocation("codex-plugin", { kind: "review", permissions: "auto" }).args).not.toContain("--write");
    expect(invocation("codex-plugin", { kind: "adversarial_review", base: "main", permissions: "auto", prompt: "x" }).args).not.toContain("--write");
  });

  test("ask permissions and reviews without a base stay in the plugin's read-only mode", () => {
    expect(invocation("codex-plugin", { permissions: "ask" }).args).not.toContain("--write");
    expect(invocation("codex-plugin", { kind: "review" }).args).toEqual(
      ["/plugins/engine.mjs", "task", "--json", "--cwd", "/tmp/wt", "--model", "m1", "--effort", "low", "--fresh", "--", "Fix the parser."],
    );
  });

  test("reviews with a base use the vendor's diff review commands", () => {
    expect(invocation("codex-plugin", { kind: "review", base: "main" }).args).toEqual(
      ["/plugins/engine.mjs", "review", "--wait", "--json", "--cwd", "/tmp/wt", "--scope", "branch", "--base", "main"],
    );
    expect(invocation("codex-plugin", { kind: "adversarial_review", base: "main", prompt: "focus on auth" }).args).toEqual(
      ["/plugins/engine.mjs", "adversarial-review", "--wait", "--json", "--cwd", "/tmp/wt", "--scope", "branch", "--base", "main", "--", "focus on auth"],
    );
    expect(invocation("grok-plugin", { kind: "adversarial_review", base: "main", prompt: "focus on auth" }).args).toEqual(
      ["/plugins/engine.mjs", "critique", "--wait", "--json", "--cwd", "/tmp/wt", "--scope", "branch", "--base", "main", "--model", "m1", "--effort", "low", "--", "focus on auth"],
    );
  });

  test("cancel and broker teardown use the plugin's own commands", () => {
    expect(cancelInvocation("grok-plugin", "/p/scripts/grok-bridge.mjs", "/tmp/wt", "/d", "abc").args).toEqual(["/p/scripts/grok-bridge.mjs", "stop", "--json", "--cwd", "/tmp/wt"]);
    expect(teardownInvocation("grok-plugin", "/p/scripts/grok-bridge.mjs", "/tmp/wt", "/d")).toBeNull();
    expect(teardownInvocation("codex-plugin", "/p/scripts/codex-companion.mjs", "/tmp/wt", "/d")).toEqual({
      command: process.execPath,
      args: ["/p/scripts/session-lifecycle-hook.mjs", "SessionEnd"],
      env: { CLAUDE_PLUGIN_DATA: "/d" },
      input: '{"cwd":"/tmp/wt","session_id":"outsrc-broker-teardown"}',
    });
  });
});

describe("plugin engine output recorded from the installed plugins", () => {
  const parse = (adapter: Adapter, stdout: string, exitCode: number | null = 0) => parseAgentOutput({ adapter, stdout, exitCode });

  test("codex and grok task payloads become a completed result with the vendor thread as the session", () => {
    expect(parse("codex-plugin", recorded("plugin-codex-task.json"))).toEqual({
      kind: "completed", message: "alpha", sessionId: "00000000-0000-4000-8000-000000000001", findings: [],
    });
    expect(parse("grok-plugin", recorded("plugin-grok-task.json"))).toEqual({
      kind: "completed", message: "alpha", sessionId: "00000000-0000-4000-8000-000000000004", findings: [],
    });
  });

  test("a NEEDS_INPUT final message ends the run as a question", () => {
    const stdout = JSON.stringify({ status: 0, threadId: "t-1", rawOutput: "NEEDS_INPUT: Which color?\n" });
    expect(parse("codex-plugin", stdout)).toEqual({ kind: "needs_input", message: "Which color?", sessionId: "t-1", findings: [] });
  });

  test("adversarial review verdicts and findings map onto mailbox findings", () => {
    expect(parse("codex-plugin", recorded("plugin-codex-adversarial.json"))).toEqual({
      kind: "completed",
      message: "Verdict: approve\n\nNo material defect is supported by the supplied diff. Division errors propagate to callers; no caller or contract establishes that this function must handle them.",
      sessionId: null,
      findings: [],
    });
    const withFinding = JSON.parse(recorded("plugin-codex-adversarial.json"));
    withFinding.result.findings = [{ severity: "critical", title: "Crash", body: "div(1, 0) raises.", file: "m.py", line_start: 2, line_end: 2, confidence: 0.9, recommendation: "Guard b." }];
    expect(parse("codex-plugin", JSON.stringify(withFinding)).findings).toEqual([
      { priority: "P0", title: "Crash", body: "div(1, 0) raises.\n\nRecommendation: Guard b.", path: "m.py", line: 2 },
    ]);
  });

  test("a grok critique whose result is Grok's response envelope still yields the verdict and findings", () => {
    const result = parse("grok-plugin", recorded("plugin-grok-critique.json"));
    expect(result.kind).toBe("completed");
    expect(result.message.split("\n")[0]).toBe("Verdict: needs-attention");
    expect(result.findings).toEqual([expect.objectContaining({ priority: "P1", title: "Unguarded division by zero", path: "m.py", line: 1 })]);
  });

  test("the native codex review returns its prose review", () => {
    expect(parse("codex-plugin", recorded("plugin-codex-review.json"))).toEqual({
      kind: "completed",
      message: "The diff only adds a function that delegates to Python division. Smoke checks passed for integer, fractional, negative, and zero-numerator inputs. No actionable defects were identified.",
      sessionId: null,
      findings: [],
    });
  });

  test("a grok read-only sandbox refusal is reported as the failure message", () => {
    const result = parse("grok-plugin", recorded("plugin-grok-critique-sandbox-failure.json"), 1);
    expect(result.kind).toBe("failed");
    expect(result.message).toContain("could not resolve runtime-socket deny path /var/run/docker.sock: endpoint is a symlink");
  });

  test("non-JSON output fails with the exit code", () => {
    expect(parse("grok-plugin", "Grok exited", 1)).toEqual({ kind: "failed", message: "Plugin engine exited with 1 without JSON output; see log", sessionId: null, findings: [] });
  });
});

describe("plugin resolution", () => {
  test("a plugin target without a command resolves the installed Claude Code plugin", () => {
    const claude = mkdtempSync(join(tmpdir(), "outsrc-claude-"));
    const install = join(claude, "cache", "codex", "9.9.9");
    mkdirSync(join(install, "scripts"), { recursive: true });
    writeFileSync(join(install, "scripts", "codex-companion.mjs"), "");
    mkdirSync(join(claude, "plugins"));
    writeFileSync(join(claude, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "codex@openai-codex": [{ installPath: install }] } }));
    expect(resolvePluginScript("codex-plugin", claude)).toBe(realpathSync(join(install, "scripts", "codex-companion.mjs")));
    expect(resolvePluginScript("grok-plugin", claude)).toBeNull();

    const home = tempHome();
    writeFileSync(join(home, "config.toml"), '[targets.grok]\nadapter = "grok-plugin"\n');
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claude;
    try { expect(loadConfigFile(join(home, "config.toml")).targets.grok).toEqual({ adapter: "grok-plugin", command: "", args: [] }); }
    finally { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; }
  });
});

describe("mailbox with a plugin engine", () => {
  function setup() {
    const home = tempHome();
    const repo = join(home, "source");
    initGitRepo(repo);
    const box = createMailbox({
      home,
      retryAfterSeconds: 1,
      nodeExecutable: process.execPath,
      config: { repos: [{ alias: "demo", path: repo }], targets: { codex: { adapter: "codex-plugin", command: FAKE_ENGINE, args: [] } } },
    });
    const calls = (threadId: string) => readFileSync(join(home, "threads", threadId, "engine", "codex-plugin", "calls.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as { args?: string[]; session?: string; cwd?: string; hook?: string });
    const status = (threadId: string) => { const r = box.inbox(threadId); return r.ok ? r.status : r.error; };
    return { box, calls, status };
  }

  test("a question ends the run, the answer resumes the plugin session, and each run stops the broker", async () => {
    const { box, calls, status } = setup();
    const sent = await box.send({ repo: "demo", target: "codex", message: "Paint the button." });
    if (!sent.ok) throw new Error(sent.error);
    await expect.poll(() => status(sent.thread_id)).toBe("needs_input");
    expect(box.inbox(sent.thread_id)).toMatchObject({ message: "Which color should I use?", session_id: "fake-codex-thread" });

    const answered = await box.send({ thread_id: sent.thread_id, message: "green" });
    if (!answered.ok) throw new Error(answered.error);
    await expect.poll(() => status(sent.thread_id)).toBe("succeeded");
    expect(box.inbox(sent.thread_id)).toMatchObject({ message: "Applied answer: green", session_id: "fake-codex-thread" });

    const log = calls(sent.thread_id);
    expect(log.map((call) => call.hook ?? call.args?.[0])).toEqual(["task", "SessionEnd", "task", "SessionEnd"]);
    expect(log[0]?.args).toContain("--fresh");
    expect(log[2]?.args).toContain("--resume-last");
    expect(log[0]?.session).toBe(sent.thread_id);
    const done = box.inbox(sent.thread_id);
    if (!done.ok || done.status !== "succeeded") throw new Error("expected a finished run");
    expect(log[0]?.args?.slice(1, 4)).toEqual(["--json", "--cwd", done.worktree]);
  });

  test("an adversarial review against a base returns the plugin's findings", async () => {
    const { box, status } = setup();
    const sent = await box.send({ repo: "demo", target: "codex", message: "focus on zero", kind: "adversarial_review", base: "HEAD" });
    if (!sent.ok) throw new Error(sent.error);
    await expect.poll(() => status(sent.thread_id)).toBe("succeeded");
    expect(box.inbox(sent.thread_id)).toMatchObject({
      message: "Verdict: needs-attention\n\nOne defect.\n\nNext steps:\n- Add a zero check",
      findings: [{ priority: "P1", title: "Division by zero", body: "div(1, 0) raises.\n\nRecommendation: Guard b == 0.", path: "m.py", line: 2 }],
    });
  });

  test("list_targets warns when the plugin version has not passed the live smoke test", () => {
    const { box } = setup();
    expect(box.listTargets().targets[0]).toMatchObject({
      name: "codex", adapter: "codex-plugin", available: true, plugin_version: "9.9.9", verified: false,
      warning: "Plugin version 9.9.9 has not passed outsrc's plugin smoke test; results may be unreliable.",
    });
  });

  test("base is rejected for tasks and must name a commit", async () => {
    const { box } = setup();
    expect(await box.send({ repo: "demo", target: "codex", message: "x", base: "HEAD" })).toEqual({ ok: false, error: "base applies only to review and adversarial_review" });
    expect(await box.send({ repo: "demo", target: "codex", message: "x", kind: "review", base: "no-such-branch" }))
      .toEqual({ ok: false, error: "base does not resolve to a commit in the repository: no-such-branch" });
    expect(await box.send({ repo: "demo", target: "codex", message: "x", ref: "--output=/tmp/x" }))
      .toEqual({ ok: false, error: "ref must name a commit, branch or tag" });
  });

  test("stop cancels through the plugin before signalling the wrapper", async () => {
    const { box, calls, status } = setup();
    const sent = await box.send({ repo: "demo", target: "codex", message: "SLEEP then finish" });
    if (!sent.ok) throw new Error(sent.error);
    await expect.poll(() => calls(sent.thread_id).length).toBe(1);
    expect(box.stop(sent.thread_id)).toEqual({ ok: true, stopped: true });
    expect(calls(sent.thread_id).map((call) => call.hook ?? call.args?.[0])).toEqual(["task", "cancel", "SessionEnd"]);
    await expect.poll(() => status(sent.thread_id)).toBe("cancelled");
  });
});
