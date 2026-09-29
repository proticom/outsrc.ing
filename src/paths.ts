import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { STORAGE_ID, type Alias, type ThreadId } from "./types.js";

export function threadsDir(home: string): string {
  return join(home, "threads");
}
export function filesystemPath(path: string): string {
  let parent = resolve(path);
  const missing: string[] = [];
  while (!existsSync(parent)) {
    missing.unshift(basename(parent));
    parent = dirname(parent);
  }
  return join(realpathSync(parent), ...missing);
}
export function resolveInside(root: string, ...segments: string[]): string {
  for (const segment of segments) {
    if (!STORAGE_ID.test(segment)) throw new Error("path escapes storage");
  }
  const base = filesystemPath(root);
  const target = filesystemPath(join(base, ...segments));
  const prefix = base.endsWith(sep) ? base : `${base}${sep}`;
  if (target !== base && !target.startsWith(prefix)) throw new Error("path escapes storage");
  return target;
}
export function threadDir(home: string, id: ThreadId): string {
  return resolveInside(home, "threads", id);
}
export function worktreePath(home: string, alias: Alias, id: ThreadId): string {
  return join(home, "worktrees", alias, id);
}
export function branchName(id: ThreadId): string {
  return `agent/outsrc-${id}`;
}
