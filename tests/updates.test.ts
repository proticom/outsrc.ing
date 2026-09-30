import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { ack, refresh, unread, updatesFile, type Probe, type Product } from "../src/updates.ts";
import { tempHome } from "./helpers.ts";

type Answers = Partial<Record<Product, string | Error>>;

function fixtureProbe(installed: Answers, latest: Answers): Probe & { calls: string[] } {
  const calls: string[] = [];
  const answer = async (table: Answers, kind: string, product: Product) => {
    calls.push(`${kind}:${product}`);
    const value = table[product];
    if (value instanceof Error) throw value;
    if (value === undefined) throw Object.assign(new Error(`spawn ${product} ENOENT`), { code: "ENOENT" });
    return value;
  };
  return { calls, installed: (p) => answer(installed, "installed", p), latest: (p) => answer(latest, "latest", p) };
}

const T1 = new Date("2026-09-29T10:00:00Z");
const T2 = new Date("2026-09-29T16:00:00Z");
const T3 = new Date("2026-09-29T22:00:00Z");

test("refresh records only products that are behind, and announces each new latest version once", async () => {
  const home = tempHome();
  const installed = { claude: "2.1.285 (Claude Code)", codex: "codex-cli 0.159.2", grok: "grok 1.0.44 (abc) [stable]", outsrc: "0.2.0" };
  const first = await refresh(home, fixtureProbe(installed, { claude: "2.1.286", codex: "0.159.2", grok: "1.0.44", outsrc: "0.2.0" }), T1);
  expect(first.fresh).toEqual([{ id: "claude@2.1.286", product: "claude", installed: "2.1.285", latest: "2.1.286", first_seen_at: T1.toISOString() }]);
  expect(first.state.checks.codex).toEqual({ installed: "0.159.2", latest: "0.159.2", error: null });

  const second = await refresh(home, fixtureProbe(installed, { claude: "2.1.286", codex: "0.160.0", grok: "1.0.44", outsrc: "0.2.0" }), T2);
  expect(second.fresh.map((note) => note.id)).toEqual(["codex@0.160.0"]);
  expect(second.state.pending.claude?.first_seen_at).toBe(T1.toISOString());

  const third = await refresh(home, fixtureProbe(installed, { claude: "2.1.287", codex: "0.160.0", grok: "1.0.44", outsrc: "0.2.0" }), T3);
  expect(third.fresh.map((note) => note.id)).toEqual(["claude@2.1.287"]);
  expect(third.state.pending.claude).toEqual({ installed: "2.1.285", latest: "2.1.287", first_seen_at: T3.toISOString() });
  expect(statSync(updatesFile(home)).mode & 0o777).toBe(0o600);
});

test("an identical rerun changes nothing and announces nothing", async () => {
  const home = tempHome();
  const probe = () => fixtureProbe({ claude: "2.1.285", codex: "0.159.2", grok: "1.0.44", outsrc: "0.2.0" }, { claude: "2.1.286", codex: "0.159.2", grok: "1.0.45", outsrc: "0.2.0" });
  await refresh(home, probe(), T1);
  const before = readFileSync(updatesFile(home), "utf8");
  const again = await refresh(home, probe(), T1);
  expect(again.fresh).toEqual([]);
  expect(readFileSync(updatesFile(home), "utf8")).toBe(before);
});

test("upgrading clears the entry; a failed lookup keeps it; an uninstalled CLI drops it", async () => {
  const home = tempHome();
  await refresh(home, fixtureProbe({ claude: "2.1.285", codex: "0.159.2", grok: "1.0.44", outsrc: "0.2.0" }, { claude: "2.1.286", codex: "0.160.0", grok: "1.0.45", outsrc: "0.2.0" }), T1);

  const next = await refresh(home, fixtureProbe(
    { claude: "2.1.286", codex: "0.159.2", outsrc: "0.2.0" },
    { claude: "2.1.286", codex: new Error("npm registry 503 for @openai/codex"), grok: "1.0.45", outsrc: "0.2.0" },
  ), T2);
  expect(next.fresh).toEqual([]);
  expect(Object.keys(next.state.pending)).toEqual(["codex"]);
  expect(next.state.pending.codex?.first_seen_at).toBe(T1.toISOString());
  expect(next.state.checks.codex?.error).toBe("npm registry 503 for @openai/codex");
  expect(next.state.checks.grok).toEqual({ installed: null, latest: "1.0.45", error: "spawn grok ENOENT" });

  const recovered = await refresh(home, fixtureProbe({ claude: "2.1.286", codex: "0.159.2", outsrc: "0.2.0" }, { claude: "2.1.286", codex: "0.160.0", grok: "1.0.45", outsrc: "0.2.0" }), T3);
  expect(recovered.fresh).toEqual([]);
});

test("unread lists pending updates until acknowledged, and a newer version is unread again", async () => {
  const home = tempHome();
  const installed = { claude: "2.1.285", codex: "0.159.2", grok: "1.0.44", outsrc: "0.2.0" };
  await refresh(home, fixtureProbe(installed, { claude: "2.1.286", codex: "0.160.0", grok: "1.0.44", outsrc: "0.2.0" }), T1);
  expect(unread(home).map((note) => note.id)).toEqual(["claude@2.1.286", "codex@0.160.0"]);
  expect(ack(home, ["claude@2.1.286"])).toEqual(["claude@2.1.286"]);
  expect(unread(home).map((note) => note.id)).toEqual(["codex@0.160.0"]);
  expect(ack(home, "all")).toEqual(["codex@0.160.0"]);
  expect(unread(home)).toEqual([]);

  await refresh(home, fixtureProbe(installed, { claude: "2.1.286", codex: "0.160.0", grok: "1.0.44", outsrc: "0.2.0" }), T2);
  expect(unread(home)).toEqual([]);
  await refresh(home, fixtureProbe(installed, { claude: "2.1.290", codex: "0.160.0", grok: "1.0.44", outsrc: "0.2.0" }), T3);
  expect(unread(home).map((note) => note.id)).toEqual(["claude@2.1.290"]);
});

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
function cli(home: string, ...args: string[]) {
  const result = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
    encoding: "utf8", env: { ...process.env, OUTSRC_HOME: home }, cwd: fileURLToPath(new URL("..", import.meta.url)),
  });
  return { status: result.status, body: JSON.parse(result.stdout) as Record<string, unknown> };
}

test("outsrc updates and outsrc doctor list pending updates from the last refresh without probing", async () => {
  const home = tempHome();
  await refresh(home, fixtureProbe({ claude: "2.1.285", codex: "0.159.2", grok: "1.0.44", outsrc: "0.2.0" }, { claude: "2.1.286", codex: "0.159.2", grok: "1.0.44", outsrc: "0.2.0" }), T1);
  const expected = [{ id: "claude@2.1.286", product: "claude", installed: "2.1.285", latest: "2.1.286", first_seen_at: T1.toISOString() }];

  const listed = cli(home, "updates");
  expect(listed.status).toBe(0);
  expect(listed.body.unread).toEqual(expected);
  expect(listed.body.checked_at).toBe(T1.toISOString());

  writeFileSync(join(home, "config.toml"), "[targets.node]\nadapter = \"custom\"\ncommand = \"node\"\n");
  const doctor = cli(home, "doctor");
  expect(doctor.body.updates).toEqual({ checked_at: T1.toISOString(), pending: { claude: { installed: "2.1.285", latest: "2.1.286", first_seen_at: T1.toISOString() } }, unread: expected });

  expect(cli(home, "updates", "ack", "--all").body).toEqual({ acked: ["claude@2.1.286"] });
  expect(cli(home, "updates").body.unread).toEqual([]);
  expect(existsSync(join(home, "updates-ack.json"))).toBe(true);
});
