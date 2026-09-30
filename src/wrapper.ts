import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { writeHomeFile } from "./fs-home.js";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { AGENT_OUTPUT_SCHEMA, buildInvocation, parseAgentOutput, type AgentOutput } from "./adapters.js";
import { captureProcess } from "./job.js";
import { LOG_TRUNCATED, MAX_LOG_BYTES, MAX_RUN_MS } from "./limits.js";
import { engineDir, isPluginAdapter, teardownInvocation } from "./plugins.js";
import { writeJson } from "./state.js";
import { parseThreadId, type RunResult, type RunSpec } from "./types.js";
import { collectWorkspaceDiff, commitWorkspace } from "./workspace.js";
import { emptyUsage, readAdapterUsage } from "./usage.js";

const RunSpecSchema: z.ZodType<RunSpec> = z.object({
  threadId: z.string().transform(parseThreadId),
  runId: z.string(),
  runDir: z.string(),
  worktree: z.string(),
  baseCommit: z.string(),
  target: z.object({
    adapter: z.enum(["claude", "codex", "grok", "custom", "codex-plugin", "grok-plugin"]),
    command: z.string(),
    args: z.array(z.string()),
  }),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  permissions: z.enum(["auto", "ask"]),
  sessionId: z.string().nullable(),
  prompt: z.string(),
  setup: z.array(z.array(z.string())),
  autoCommit: z.boolean(),
  kind: z.enum(["task", "review", "adversarial_review"]),
  base: z.string().nullable(),
});
const DeadlineSchema = z.object({ deadlineMs: z.number().int().positive().nullable().optional() });

function failure(message: string, sessionId: string | null): AgentOutput {
  return { kind: "failed", message, sessionId, findings: [] };
}

type ExecutionResult = { stdout: string; exitCode: number | null } & (
  | { kind: "exited" }
  | { kind: "failed"; error: unknown }
);

function execute(input: {
  command: string;
  args: string[];
  cwd: string;
  logPath: string;
  deadlineMs: number | null;
  env?: Record<string, string>;
  onStdout?: (stdout: string) => void;
}): Promise<ExecutionResult> {
  return new Promise((resolveResult) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: { ...process.env, ...input.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let logError: unknown;
    let logged = 0;
    let truncated = false;
    let settled = false;
    let timedOut = false;
    const marker = Buffer.from(LOG_TRUNCATED);
    function append(chunk: Buffer): void {
      try {
        if (truncated) return;
        const room = MAX_LOG_BYTES - logged;
        if (room <= 0) {
          appendFileSync(input.logPath, marker);
          truncated = true;
          return;
        }
        const slice = chunk.subarray(0, room);
        appendFileSync(input.logPath, slice);
        logged += slice.length;
        if (slice.length < chunk.length) {
          appendFileSync(input.logPath, marker);
          truncated = true;
        }
      } catch (error) {
        logError = error;
      }
    }
    function finish(error: unknown, exitCode: number | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = { stdout: Buffer.concat(stdout).toString("utf8"), exitCode };
      resolveResult(error === undefined ? { ...output, kind: "exited" } : { ...output, kind: "failed", error });
    }
    const timer = input.deadlineMs === null ? undefined : setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 500);
      killTimer.unref();
    }, input.deadlineMs);
    timer?.unref();
    child.once("error", (error) => finish(error, null));
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      append(chunk);
      try { input.onStdout?.(Buffer.concat(stdout).toString("utf8")); }
      catch (error) { logError = error; }
    });
    child.stderr.on("data", append);
    child.once("close", (exitCode) => {
      if (timedOut) finish(new Error(`Run exceeded the ${input.deadlineMs}ms deadline`), exitCode);
      else if (logError !== undefined) finish(logError, null);
      else finish(undefined, exitCode);
    });
  });
}

export async function run(spec: RunSpec): Promise<RunResult> {
  const startedAt = performance.now();
  let usage = emptyUsage();
  let output = failure("Agent did not run", spec.sessionId);
  let exitCode: number | null = null;
  let commit: string | null = null;
  let diffstat = "";
  let phase = "Run preparation";
  const logPath = join(spec.runDir, "run.log");
  const deadlineMs = spec.deadlineMs === undefined ? MAX_RUN_MS : spec.deadlineMs;
  const deadlineAt = deadlineMs === null ? null : Date.now() + deadlineMs;
  function timeLeft(): number | null {
    if (deadlineAt === null) return null;
    const left = deadlineAt - Date.now();
    if (left <= 0) throw new Error(`Run exceeded the ${deadlineMs}ms deadline`);
    return left;
  }
  function publish(result: Omit<RunResult, "usage">): RunResult {
    const recorded: RunResult = { ...result,
      ...(existsSync(join(spec.runDir, "cancelled")) ? { kind: "cancelled", message: "Task cancelled" } : {}),
      usage: { ...usage, wall_minutes: (performance.now() - startedAt) / 60_000 } };
    const temporary = join(spec.runDir, "result.json.tmp");
    writeHomeFile(temporary, JSON.stringify(recorded));
    renameSync(temporary, join(spec.runDir, "result.json"));
    return recorded;
  }
  mkdirSync(spec.runDir, { recursive: true, mode: 0o700 }); try { chmodSync(spec.runDir, 0o700); } catch {}
  if (existsSync(join(spec.runDir, "cancelled"))) {
    return publish({
      kind: "cancelled", message: "Task cancelled", sessionId: spec.sessionId, findings: [],
      exitCode: null, finishedAt: new Date().toISOString(), diffstat: "", commit: null,
    });
  }
  try {
    writeFileSync(logPath, "");
    const schemaPath = join(spec.runDir, "output-schema.json");
    writeFileSync(schemaPath, JSON.stringify(AGENT_OUTPUT_SCHEMA));
    for (const [index, command] of spec.setup.entries()) {
      phase = `Setup command ${index + 1}`;
      const [executable, ...args] = command;
      if (!executable) throw new Error("command is empty");
      const setup = await execute({ command: executable, args, cwd: spec.worktree, logPath, deadlineMs: timeLeft() });
      if (setup.kind === "failed") throw setup.error;
      if (setup.exitCode !== 0) {
        exitCode = setup.exitCode;
        throw new Error(`exited with ${setup.exitCode ?? "a signal"}`);
      }
    }
    phase = "Agent execution";
    const dataDir = isPluginAdapter(spec.target.adapter) ? engineDir(dirname(dirname(spec.runDir)), spec.target.adapter) : "";
    const invocation = buildInvocation({
      target: spec.target,
      worktree: spec.worktree,
      prompt: spec.prompt,
      model: spec.model,
      effort: spec.effort,
      sessionId: spec.sessionId,
      schemaPath,
      permissions: spec.permissions,
      kind: spec.kind,
      base: spec.base,
      dataDir,
      threadId: spec.threadId,
    });
    const ignoresEffort = (spec.target.adapter === "codex-plugin" && spec.kind !== "task" && spec.base !== null) ||
      (spec.target.adapter === "custom" && !spec.target.args.some((arg) => arg.includes("{effort}")));
    usage.effort = ignoresEffort ? null : spec.effort;
    const ignoresModel = (spec.target.adapter === "codex-plugin" && spec.kind !== "task" && spec.base !== null) ||
      (spec.target.adapter === "custom" && !spec.target.args.some((arg) => arg.includes("{model}")));
    usage.model = ignoresModel ? null : spec.model;
    let savedUsage = JSON.stringify(usage);
    function captureUsage(stdout: string): void {
      if (spec.target.adapter !== "codex") {
        try { JSON.parse(stdout); }
        catch { return; }
      }
      const reported = readAdapterUsage({ adapter: spec.target.adapter, stdout });
      usage = { ...reported, model: reported.model ?? usage.model, effort: usage.effort };
      const serialized = JSON.stringify(usage);
      if (serialized === savedUsage) return;
      writeJson(join(spec.runDir, "usage.json"), usage);
      savedUsage = serialized;
    }
    writeJson(join(spec.runDir, "usage.json"), usage);
    let executed: Awaited<ReturnType<typeof execute>>;
    try {
      const supportsUsage = spec.target.adapter !== "custom" && spec.target.adapter !== "codex-plugin";
      executed = await execute({ ...invocation, cwd: spec.worktree, logPath, deadlineMs: timeLeft(),
        ...(supportsUsage ? { onStdout: captureUsage } : {}) });
      exitCode = executed.exitCode;
      if (supportsUsage) captureUsage(executed.stdout);
      if (executed.kind === "failed") throw executed.error;
    } finally {
      if (isPluginAdapter(spec.target.adapter)) {
        const teardown = teardownInvocation(spec.target.adapter, spec.target.command, spec.worktree, dataDir);
        if (teardown) {
          spawnSync(teardown.command, teardown.args, {
            cwd: spec.worktree, input: teardown.input, env: { ...process.env, ...teardown.env }, stdio: ["pipe", "ignore", "ignore"], timeout: 15_000,
          });
        }
      }
    }
    exitCode = executed.exitCode;
    output = parseAgentOutput({ adapter: spec.target.adapter, stdout: executed.stdout, exitCode });
    output.sessionId ??= spec.sessionId;
    if (output.kind === "needs_input" && spec.target.adapter === "custom" &&
        !spec.target.args.some((arg) => arg.includes("{session_id}"))) {
      output = failure("Custom adapter requested input but has no {session_id} argument for resuming", output.sessionId);
    }
    if (output.kind === "completed" && spec.autoCommit) {
      phase = "Automatic commit";
      commit = commitWorkspace({
        workspace: spec.worktree,
        message: `outsrc: complete ${spec.threadId}`,
      }).commit;
    }
  } catch (error) {
    output = failure(`${phase} failed: ${String(error)}`, output.sessionId);
  }
  try {
    diffstat = collectWorkspaceDiff({ workspace: spec.worktree, baseCommit: spec.baseCommit }).stat;
  } catch (error) {
    const context = output.kind === "failed" ? `${output.message}\n` : "";
    output = failure(`${context}Result collection failed: ${String(error)}`, output.sessionId);
  }
  return publish({
    ...output,
    exitCode,
    finishedAt: new Date().toISOString(),
    diffstat,
    commit,
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { spec: { type: "string" } }, strict: true });
  if (!values.spec) throw new Error("wrapper: --spec is required");
  const raw: unknown = JSON.parse(readFileSync(values.spec, "utf8"));
  const parsed = RunSpecSchema.parse(raw);
  const deadlineMs = DeadlineSchema.parse(raw).deadlineMs;
  const spec = deadlineMs === undefined ? parsed : { ...parsed, deadlineMs };
  mkdirSync(spec.runDir, { recursive: true, mode: 0o700 }); try { chmodSync(spec.runDir, 0o700); } catch {}
  const recorded = captureProcess(process.pid);
  if (!recorded) throw new Error("process start time is unavailable");
  writeJson(join(spec.runDir, "process.json"), recorded);
  const result = await run(spec);
  process.exitCode = result.kind === "failed" ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
