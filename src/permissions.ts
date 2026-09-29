import { basename } from "node:path";
import type { PermissionMode } from "./types.js";

export function permissionFlags(
  command: string,
  args: string[],
  mode: PermissionMode,
): string[] {
  if (mode !== "auto") return [];
  const name = basename(command);
  const has = (flag: string) => args.includes(flag);
  if (name === "claude") {
    if (has("--dangerously-skip-permissions") || has("bypassPermissions")) {
      return [];
    }
    return ["--permission-mode", "bypassPermissions"];
  }
  if (name === "codex") {
    if (
      has("--approve-for-me") ||
      has("--dangerously-bypass-approvals-and-sandbox")
    ) {
      return [];
    }
    return ["--approve-for-me"];
  }
  if (name === "grok") {
    if (
      has("--always-approve") ||
      has("dontAsk") ||
      has("bypassPermissions")
    ) {
      return [];
    }
    return ["--always-approve"];
  }
  return [];
}
