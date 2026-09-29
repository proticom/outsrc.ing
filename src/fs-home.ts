import { appendFileSync, chmodSync, mkdirSync, writeFileSync, type WriteFileOptions } from "node:fs";

/** Create ~/.outsrc (or OUTSRC_HOME) as 0700. */
export function ensureOutsrcHome(home: string): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  try { chmodSync(home, 0o700); } catch { /* best-effort on platforms that ignore mode */ }
}

/** Write a file under the outsrc home with mode 0600. */
export function writeHomeFile(path: string, data: string | Uint8Array, options?: WriteFileOptions): void {
  const opts = typeof options === "string"
    ? { encoding: options as BufferEncoding, mode: 0o600 }
    : { ...(options ?? {}), mode: 0o600 };
  writeFileSync(path, data, opts as WriteFileOptions);
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
}

/** Append to a file under the outsrc home with mode 0600 (created if missing). */
export function appendHomeFile(path: string, data: string | Uint8Array): void {
  appendFileSync(path, data, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
}
