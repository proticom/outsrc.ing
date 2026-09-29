import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MailboxContext } from "./types.js";

export type ProcessRecord = { pid: number; pgid: number; startedAt: string };

const source = fileURLToPath(import.meta.url).endsWith(".ts");
const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_WRAPPER = join(here, source ? "wrapper.ts" : "wrapper.js");
const BASE_ENV = ["PATH", "HOME", "USER", "LANG", "TMPDIR", "TERM"] as const;
// Set in every job's environment. An outsrc server started by an agent inside a job sees it and refuses to send,
// so a delegated agent cannot delegate onward.
export const JOB_MARKER = "OUTSRC_JOB";
export function jobEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of BASE_ENV) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return { ...env, [JOB_MARKER]: "1", ...extra };
}
export function commandExists(command: string): boolean {
  if (!command) return false;
  if (command.includes("/") || command.startsWith(".")) return existsSync(command);
  return (process.env.PATH ?? "").split(":").some((dir) => existsSync(join(dir, command)));
}
// lstart is formatted by the caller's locale and time zone; pin both so the recording and checking processes agree.
function startTime(pid: number): string {
  return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC0" } }).trim();
}
export function captureProcess(pid: number): ProcessRecord | null {
  if (!Number.isInteger(pid) || pid < 2) return null;
  try {
    const startedAt = startTime(pid);
    if (!startedAt) return null;
    return { pid, pgid: pid, startedAt };
  } catch {
    return null;
  }
}
export function processIdentity(record: ProcessRecord): "match" | "mismatch" | "unknown" {
  if (!Number.isInteger(record.pid) || record.pid < 2 || record.pgid !== record.pid || record.startedAt.length === 0) return "mismatch";
  try {
    const startedAt = startTime(record.pid);
    if (!startedAt) return "unknown";
    return startedAt === record.startedAt ? "match" : "mismatch";
  } catch {
    return "unknown";
  }
}
export function sameProcess(record: ProcessRecord): boolean {
  return processIdentity(record) === "match";
}
export async function startWrapper(input: { ctx: MailboxContext; specFile: string }): Promise<ProcessRecord | null> {
  const node = input.ctx.nodeExecutable ?? process.execPath;
  const wrapper = input.ctx.wrapperCommand ?? [node, ...(source ? ["--import", import.meta.resolve("tsx")] : []), DEFAULT_WRAPPER];
  const command = wrapper[0];
  if (!command) throw new Error("wrapper command is empty");
  const env = jobEnv();
  const child = spawn(command, [...wrapper.slice(1), "--spec", input.specFile], {
    detached: true,
    stdio: "ignore",
    env,
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", resolve);
  });
  child.unref();
  if (child.pid === undefined) throw new Error("failed to spawn wrapper");
  return captureProcess(child.pid);
}
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}
export function stopOwnedProcess(record: ProcessRecord): boolean {
  if (!sameProcess(record)) return false;
  try { process.kill(-record.pgid, "SIGTERM"); }
  catch { return false; }
  const killer = setTimeout(() => {
    if (!sameProcess(record)) return;
    try { process.kill(-record.pgid, "SIGKILL"); }
    catch { return; }
  }, 2000);
  killer.unref();
  return true;
}
