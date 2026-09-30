import { readFileSync } from "node:fs";
import { z } from "zod";

export const REGISTRY_LATEST_URL = "https://registry.npmjs.org/outsrc/latest";

// Doctor only reports. Upgrading stays with the owner: `npm install -g outsrc@latest`.
export type UpdateCheck =
  | { status: "current" | "outdated" | "ahead"; installed: string; latest: string }
  | { status: "unknown"; installed: string; latest: null; error: string };

export type FetchLatest = () => Promise<string>;

export function installedVersion(): string {
  // src/ and dist/ both sit one level below the package root, which npm always ships package.json in.
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as unknown;
  return z.object({ version: z.string() }).parse(pkg).version;
}

type Parsed = { core: [number, number, number]; pre: string[] };

function parseVersion(version: string): Parsed | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim());
  if (!match) return null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4]?.split(".") ?? [] };
}

function comparePre(a: string[], b: string[]): number {
  if (!a.length || !b.length) return Math.sign(b.length - a.length);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const x = a[index];
    const y = b[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn && Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// Semver precedence: negative when a < b, 0 when equal, positive when a > b. Null when either is not semver.
export function compareVersions(a: string, b: string): number | null {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let index = 0; index < 3; index++) {
    if (x.core[index] !== y.core[index]) return x.core[index]! < y.core[index]! ? -1 : 1;
  }
  return comparePre(x.pre, y.pre);
}

export function registryFetchLatest(timeoutMs = 3000): FetchLatest {
  return async () => {
    const response = await fetch(REGISTRY_LATEST_URL, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`registry returned HTTP ${response.status}`);
    return z.object({ version: z.string() }).parse(await response.json()).version;
  };
}

// Never throws: a registry or network failure becomes status "unknown" so doctor still reports everything else.
export async function checkForUpdate(installed: string, fetchLatest: FetchLatest): Promise<UpdateCheck> {
  let latest: string;
  try {
    latest = await fetchLatest();
  } catch (error) {
    return { status: "unknown", installed, latest: null, error: error instanceof Error ? error.message : String(error) };
  }
  const order = compareVersions(installed, latest);
  if (order === null) return { status: "unknown", installed, latest: null, error: `cannot compare versions ${installed} and ${latest}` };
  return { status: order < 0 ? "outdated" : order > 0 ? "ahead" : "current", installed, latest };
}

export function updateAvailable(check: UpdateCheck): boolean {
  return check.status === "outdated";
}

export function describeUpdate(check: UpdateCheck): string {
  switch (check.status) {
    case "outdated":
      return `outsrc ${check.installed} is installed; ${check.latest} is available. Upgrade with: npm install -g outsrc@latest`;
    case "current":
      return `outsrc ${check.installed} is the latest version.`;
    case "ahead":
      return `outsrc ${check.installed} is newer than the latest published version ${check.latest}.`;
    case "unknown":
      return `outsrc ${check.installed} is installed; could not check for updates (${check.error}).`;
  }
}
