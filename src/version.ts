// Semver-shaped versions as the CLIs print them: "2.1.285 (Claude Code)", "codex-cli 0.159.2", "grok 1.0.44 (abc) [stable]".
const VERSION = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/;

export type Version = { major: number; minor: number; patch: number; prerelease: string[]; text: string };

/** First x.y.z[-pre] in the text, or null. */
export function parseVersion(text: string): Version | null {
  const match = VERSION.exec(text);
  if (!match) return null;
  const [whole, major, minor, patch, pre] = match;
  return { major: Number(major), minor: Number(minor), patch: Number(patch), prerelease: pre ? pre.split(".") : [], text: whole };
}

function comparePrerelease(a: string[], b: string[]): number {
  // A release sorts above any of its prereleases.
  if (a.length === 0 || b.length === 0) return b.length - a.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x) ? Number(x) : null;
    const ny = /^\d+$/.test(y) ? Number(y) : null;
    if (nx !== null && ny !== null) return nx - ny;
    if (nx !== null) return -1;
    if (ny !== null) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** Negative when a is older than b, zero when equal, positive when newer. */
export function compareVersions(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch || comparePrerelease(a.prerelease, b.prerelease);
}

/** True when both parse and latest is newer than installed. */
export function isBehind(installed: string, latest: string): boolean {
  const a = parseVersion(installed);
  const b = parseVersion(latest);
  return a !== null && b !== null && compareVersions(a, b) < 0;
}
