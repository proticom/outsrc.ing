import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { initGitRepo, tempHome } from "./helpers.ts";

const project = fileURLToPath(new URL("..", import.meta.url));

function outsrc(home: string, ...args: string[]) {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { cwd: project, env: { ...process.env, OUTSRC_HOME: home }, encoding: "utf8" });
  return { status: result.status, json: JSON.parse(result.stdout), stderr: result.stderr };
}

function setupHome() {
  const home = tempHome();
  const repo = join(home, "outsrc.ing");
  initGitRepo(repo);
  writeFileSync(join(home, "config.toml"), `[[repos]]\nalias = "outsrc.ing"\npath = ${JSON.stringify(repo)}\n\n[targets.claude]\nadapter = "claude"\ncommand = "claude"\n`);
  return { home };
}

describe("outsrc config", () => {
  test("lists every setting with defaults filled in, and the keys that can change", () => {
    const { home } = setupHome();
    const listed = outsrc(home, "config").json;
    expect(listed.limits).toEqual({ max_jobs: 4, max_run_minutes: 120 });
    expect(listed.repos).toEqual([{ alias: "outsrc.ing", path: join(home, "outsrc.ing"), setup: [], auto_commit: false, retention_days: null }]);
    expect(listed.targets.claude).toEqual({ adapter: "claude", command: "claude", args: [], permissions: "auto", models: null, effort: null, description: "", cost_note: "" });
    expect(listed.settings.map((setting: { key: string }) => setting.key)).toContain("limits.max_jobs");
  });

  test("unlimited is allowed and comes with the risk", () => {
    const { home } = setupHome();
    const set = outsrc(home, "config", "set", "limits.max_jobs", "unlimited");
    expect(set.json).toMatchObject({ ok: true, key: "limits.max_jobs", value: "unlimited" });
    expect(set.stderr).toContain("A looping or confused bot can start many agents together");
    expect(outsrc(home, "config").json.limits).toEqual({ max_jobs: "unlimited", max_run_minutes: 120 });
    expect(outsrc(home, "config", "unset", "limits.max_jobs").json).toMatchObject({ ok: true });
    expect(outsrc(home, "config").json.limits.max_jobs).toBe(4);
  });

  test("an invalid value is refused and the file is left alone", () => {
    const { home } = setupHome();
    const before = readFileSync(join(home, "config.toml"), "utf8");
    const set = outsrc(home, "config", "set", "limits.max_run_minutes", "0");
    expect(set.status).toBe(1);
    expect(set.json.ok).toBe(false);
    expect(set.json.error).toContain("invalid value for limits.max_run_minutes");
    expect(readFileSync(join(home, "config.toml"), "utf8")).toBe(before);
    expect(outsrc(home, "config", "set", "limits.speed", "3").json).toEqual({ ok: false, error: "unknown setting: limits.speed. Run outsrc config to see every setting" });
  });

  test("repository options work on an alias that contains a dot", () => {
    const { home } = setupHome();
    expect(outsrc(home, "config", "set", "repos.outsrc.ing.auto_commit", "true").json).toMatchObject({ ok: true, value: true });
    expect(outsrc(home, "config", "set", "repos.outsrc.ing.setup", '[["npm","ci"]]').json).toMatchObject({ ok: true });
    expect(outsrc(home, "config", "set", "repos.outsrc.ing.retention_days", "14").json).toMatchObject({ ok: true });
    expect(outsrc(home, "config").json.repos[0]).toMatchObject({ alias: "outsrc.ing", setup: [["npm", "ci"]], auto_commit: true, retention_days: 14 });
    expect(outsrc(home, "config", "set", "repos.outsrc.ing.retention_days", "off").json).toMatchObject({ ok: true });
    expect(outsrc(home, "config").json.repos[0].retention_days).toBe(null);
  });

  test("repositories are added only with a real git checkout, and can be removed", () => {
    const { home } = setupHome();
    const other = join(home, "other");
    initGitRepo(other);
    expect(outsrc(home, "config", "set", "repos.other", JSON.stringify({ path: other })).json).toMatchObject({ ok: true });
    expect(outsrc(home, "config").json.repos.map((repo: { alias: string }) => repo.alias)).toEqual(["outsrc.ing", "other"]);
    expect(outsrc(home, "config", "set", "repos.nope.path", "/definitely/not/a/repo").json).toEqual({ ok: false, error: "not a git repository: /definitely/not/a/repo" });
    expect(outsrc(home, "config", "unset", "repos.other").json).toMatchObject({ ok: true });
    expect(outsrc(home, "config").json.repos.map((repo: { alias: string }) => repo.alias)).toEqual(["outsrc.ing"]);
  });

  test("target options accept a comma list, and a default must be allowed", () => {
    const { home } = setupHome();
    expect(outsrc(home, "config", "set", "targets.claude.effort", '{"default":"medium","allowed":["low","medium"]}').json).toMatchObject({ ok: true });
    expect(outsrc(home, "config", "set", "targets.claude.effort.allowed", "low, medium, high").json).toMatchObject({ ok: true, value: ["low", "medium", "high"] });
    expect(outsrc(home, "config", "set", "targets.claude.effort.default", "max").json.error).toContain("default must be one of allowed");
    expect(outsrc(home, "config", "set", "targets.claude.permissions", "ask").json).toMatchObject({ ok: true, warning: null });
    expect(outsrc(home, "config").json.targets.claude).toMatchObject({ permissions: "ask", effort: { default: "medium", allowed: ["low", "medium", "high"] } });
  });
});
