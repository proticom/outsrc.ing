import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { describe, expect, test } from "vitest";
import { mergeConfig, NEEDS_HUMAN, parseInitArgs, runInit, type Cli, type InitEnv, type InitOptions, type Run } from "../src/init.ts";
import { initGitRepo } from "./helpers.ts";

const ENGINE = fileURLToPath(new URL("./fixtures/fake-plugin/scripts/codex-companion.mjs", import.meta.url));
const SERVER = ["/usr/local/bin/node", "/opt/outsrc/dist/server.js"];
const ok = (stdout = ""): Run => ({ status: 0, stdout, stderr: "" });

type Setup = {
  clis?: Cli[];
  loggedIn?: Cli[];
  engines?: { "codex-plugin"?: string; "grok-plugin"?: string };
  downloadFails?: boolean;
  claudeEngines?: ("codex-plugin" | "grok-plugin")[];
  registered?: string[];
  serverCommand?: string[];
  answers?: boolean[];
  asks?: string[];
};

function harness(setup: Setup = {}) {
  const home = mkdtempSync(join(tmpdir(), "outsrc-init-"));
  const repo = join(home, "My Repo");
  initGitRepo(repo);
  const clis = new Set(setup.clis ?? ["claude", "codex"]);
  const loggedIn = new Set(setup.loggedIn ?? [...clis]);
  const engines: Partial<Record<"codex-plugin" | "grok-plugin", string>> = { "codex-plugin": ENGINE, ...setup.engines };
  const answers = [...(setup.answers ?? [])];
  const asks = [...(setup.asks ?? [])];
  const confirms: string[] = [];
  const calls: string[] = [];
  const output: string[] = [];
  const events: Record<string, unknown>[] = [];
  const paths: Record<string, string> = { git: "/usr/bin/git", claude: process.execPath, codex: "/usr/local/bin/codex", grok: "/usr/local/bin/grok" };
  const env: InitEnv = {
    configPath: join(home, ".outsrc", "config.toml"),
    serverCommand: setup.serverCommand ?? SERVER,
    which: (command) => (command === "git" || clis.has(command as Cli) ? paths[command] ?? null : null),
    run: (command, args): Run => {
      if (command === "git") {
        const result = spawnSync("git", args, { encoding: "utf8" });
        return { status: result.status, stdout: result.stdout, stderr: result.stderr };
      }
      const line = [command, ...args].join(" ");
      if (line === "claude auth status --json") return ok(JSON.stringify({ loggedIn: loggedIn.has("claude") }));
      if (line === "codex login status" || line === "grok models") return { status: loggedIn.has(command as Cli) ? 0 : 1, stdout: "", stderr: "" };
      calls.push(line);
      if (args[0] === "mcp" && args[1] === "get") return { status: (setup.registered ?? []).includes(command) ? 0 : 1, stdout: "", stderr: "" };
      return ok();
    },
    runInteractive: (command, args) => { calls.push(`interactive: ${[command, ...args].join(" ")}`); loggedIn.add(command as Cli); return 0; },
    runStreaming: async (command, args, onLine) => {
      calls.push(`streaming: ${[command, ...args].join(" ")}`);
      return 0;
    },
    emit: (event) => events.push(event),
    confirm: async (question) => {
      confirms.push(question);
      const answer = answers.shift();
      if (answer === undefined) throw new Error(`unexpected prompt: ${question}`);
      return answer;
    },
    ask: async () => asks.shift() ?? "",
    print: (line) => output.push(line),
    engineScript: (adapter) => engines[adapter] ?? null,
    claudeEngine: (adapter) => ((setup.claudeEngines ?? []).includes(adapter) ? `/claude/${adapter}.mjs` : null),
    installEngine: (adapter) => {
      calls.push(`download ${adapter}`);
      if (setup.downloadFails) throw new Error("network unreachable");
      engines[adapter] = `/home/.outsrc/engines/${adapter}/abc1234def/scripts/engine.mjs`;
      return { version: "0.2.0", commit: "abc1234def5678" };
    },
  };
  const options = (changes: Partial<InitOptions> = {}): InitOptions => ({
    repos: [repo], yes: true, json: true, plugins: null, local: [], limits: {}, ...changes,
  });
  const toplevel = execFileSync("git", ["-C", repo, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  return { env, options, calls, output, events, confirms, toplevel, config: () => readFileSync(env.configPath, "utf8") };
}

function settingsEvent(limits: Record<string, unknown> = { max_jobs: 4, max_run_minutes: 120 }) {
  return {
    event: "settings", limits, repos: ["my-repo"], targets: ["claude", "codex"],
    instructions: "Review these with the owner: run outsrc config for every setting and its meaning, and outsrc config set <key> <value> for each change they ask for.",
  };
}

describe("outsrc init", () => {
  test("writes the allowlist and a target per installed CLI, preferring the Codex plugin engine", async () => {
    const h = harness();
    expect(await runInit(h.env, h.options())).toBe(0);
    expect(parse(h.config())).toEqual({
      repos: [{ alias: "my-repo", path: h.toplevel }],
      targets: {
        claude: { adapter: "claude", command: process.execPath, args: [], permissions: "auto", description: "Coding tasks and review through the Claude Code CLI.", cost_note: "Uses this machine's claude account.", effort: { default: "medium", allowed: ["low", "medium", "high", "xhigh", "max"] } },
        codex: { adapter: "codex-plugin", permissions: "auto", description: "Coding tasks and code review through Codex, including its built-in and adversarial reviewers.", cost_note: "Uses this machine's codex account.", effort: { default: "medium", allowed: ["low", "medium", "high", "xhigh"] } },
      },
    });
    expect(h.calls).toEqual([]);
    expect(h.events).toEqual([settingsEvent(), { event: "done", status: "ok", config: h.env.configPath, pending: [] }]);
  });

  test("limits given by the agent are written, and unlimited is allowed", async () => {
    const h = harness();
    expect(await runInit(h.env, h.options({ limits: { max_jobs: "unlimited", max_run_minutes: "45" } }))).toBe(0);
    expect(parse(h.config())).toHaveProperty("limits", { max_jobs: "unlimited", max_run_minutes: 45 });
    expect(h.events[0]).toEqual(settingsEvent({ max_jobs: "unlimited", max_run_minutes: 45 }));
    expect(h.output.join("\n")).toContain("limits.max_jobs = unlimited. No cap on jobs working at once.");
  });

  test("a person who asks for unlimited sees the risk and can back out", async () => {
    const h = harness({ answers: [false], asks: ["", "unlimited", "30"] });
    expect(await runInit(h.env, h.options({ yes: false, json: false, local: [] }))).toBe(0);
    expect(parse(h.config())).toHaveProperty("limits", { max_run_minutes: 30 });
    expect(h.confirms.at(-1)).toContain("A looping or confused bot can start many agents together");
  });

  test("an invalid limit stops setup with the reason", async () => {
    const h = harness();
    await expect(runInit(h.env, h.options({ limits: { max_jobs: "0" } }))).rejects.toThrow("invalid value for limits.max_jobs");
  });

  test("a rerun leaves the config byte-identical and skips an agent that already has outsrc", async () => {
    const h = harness({ registered: ["claude"] });
    await runInit(h.env, h.options({ local: ["claude", "codex"] }));
    const first = h.config();
    h.calls.length = 0;
    await runInit(h.env, h.options({ local: ["claude", "codex"] }));
    expect(h.config()).toBe(first);
    expect(h.calls).toEqual(["claude mcp get outsrc", "codex mcp get outsrc", `codex mcp add outsrc -- ${SERVER.join(" ")} --caller codex`]);
  });

  test("an agent run stops for a missing login with the command a person must run, and still writes config", async () => {
    const h = harness({ loggedIn: ["claude"] });
    expect(await runInit(h.env, h.options())).toBe(NEEDS_HUMAN);
    const human = { step: "login", cli: "codex", command: "codex login --device-auth", instructions: "Log in to codex: run `codex login --device-auth` on this machine and finish the sign-in." };
    expect(h.events).toEqual([
      { event: "needs_human", ...human },
      settingsEvent(),
      { event: "done", status: "needs_human", config: h.env.configPath, pending: [human] },
    ]);
    expect(parse(h.config())).toHaveProperty("targets.codex.adapter", "codex-plugin");
  });

  test("a person is offered the login and the wizard continues once it succeeds", async () => {
    const h = harness({ loggedIn: ["claude"], answers: [true] });
    expect(await runInit(h.env, h.options({ yes: false, json: false, local: [] }))).toBe(0);
    expect(h.calls).toEqual(["interactive: codex login"]);
  });

  test("the pinned Grok engine is downloaded without Claude Code and the target resolves to it at load", async () => {
    const h = harness({ clis: ["grok"] });
    expect(await runInit(h.env, h.options())).toBe(0);
    expect(h.calls).toEqual(["download grok-plugin"]);
    expect(parse(h.config())).toHaveProperty("targets.grok", {
      adapter: "grok-plugin", permissions: "auto", description: "Coding tasks and critique through Grok Build.",
      cost_note: "Uses this machine's grok account.", effort: { default: "medium", allowed: ["low", "medium", "high"] },
    });
    expect(h.output).toContain("  grok: downloaded xai-org/grok-build-plugin-cc 0.2.0 (abc1234)");
  });

  test("the pinned engine is downloaded even when Claude Code has its own copy, which stays the fallback", async () => {
    const pinned = harness({ clis: ["grok"], claudeEngines: ["grok-plugin"] });
    await runInit(pinned.env, pinned.options());
    expect(pinned.calls).toEqual(["download grok-plugin"]);
    const offline = harness({ clis: ["grok"], claudeEngines: ["grok-plugin"], downloadFails: true });
    await runInit(offline.env, offline.options());
    expect(parse(offline.config())).toHaveProperty("targets.grok.adapter", "grok-plugin");
    expect(offline.output).toContain("  grok: could not download xai-org/grok-build-plugin-cc, using Claude Code's copy of the plugin, which is not pinned: network unreachable");
  });

  test("--no-plugins, or a failed download, calls the CLI directly", async () => {
    const declined = harness({ clis: ["grok"] });
    await runInit(declined.env, declined.options({ plugins: false }));
    expect(declined.calls).toEqual([]);
    expect(parse(declined.config())).toHaveProperty("targets.grok.adapter", "grok");
    const offline = harness({ clis: ["grok"], downloadFails: true });
    await runInit(offline.env, offline.options());
    expect(parse(offline.config())).toHaveProperty("targets.grok.command", "/usr/local/bin/grok");
    expect(offline.output).toContain("  grok: could not download xai-org/grok-build-plugin-cc, calling the CLI directly: network unreachable");
  });

  test("init finishes without webmcp and without remote wiring", async () => {
    const h = harness();
    expect(await runInit(h.env, h.options())).toBe(0);
    expect(h.calls.filter((c) => c.includes("webmcp"))).toEqual([]);
    expect(h.output.join("\n")).toContain("Done. Run `outsrc doctor` any time to recheck.");
    expect(h.output.join("\n")).not.toContain("webmcp");
    expect(h.output.join("\n")).not.toContain("local-exec");
  });

  test("an npx run writes config but does not register the temporary copy with any agent", async () => {
    const h = harness({ serverCommand: ["/usr/local/bin/node", "/Users/x/.npm/_npx/abc/node_modules/outsrc/dist/server.js"] });
    expect(await runInit(h.env, h.options({ local: ["claude"] }))).toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.events.at(-1)).toMatchObject({ event: "done", status: "ok", error: "npx copy not registered" });
  });

  test("existing targets and repositories win, and a clashing alias gets a suffix", () => {
    const existing = '[[repos]]\nalias = "my-repo"\npath = "/elsewhere/my-repo"\n\n[targets.claude]\nadapter = "claude"\ncommand = "/custom/claude"\npermissions = "ask"\n';
    const merged = mergeConfig(existing, [{ alias: "my-repo", path: "/work/my-repo" }, { alias: "dup", path: "/elsewhere/my-repo" }], {
      claude: { adapter: "claude", command: "/new/claude" }, grok: { adapter: "grok", command: "/bin/grok" },
    });
    expect(merged.addedRepos).toEqual(["my-repo-2"]);
    expect(merged.addedTargets).toEqual(["grok"]);
    expect(parse(merged.toml)).toEqual({
      repos: [{ alias: "my-repo", path: "/elsewhere/my-repo" }, { alias: "my-repo-2", path: "/work/my-repo" }],
      targets: { claude: { adapter: "claude", command: "/custom/claude", permissions: "ask" }, grok: { adapter: "grok", command: "/bin/grok" } },
    });
  });

  test("a path outside git is rejected", async () => {
    const h = harness();
    await expect(runInit(h.env, h.options({ repos: [tmpdir()] }))).rejects.toThrow(`not a git repository: ${tmpdir()}`);
  });

  test("flags parse into options; --json implies --yes", () => {
    expect(parseInitArgs(["--repo", "a", "--repo", "b", "--json", "--plugins", "--local", "claude,grok"]))
      .toEqual({ repos: ["a", "b"], yes: true, json: true, plugins: true, local: ["claude", "grok"], limits: {} });
    expect(() => parseInitArgs(["--local", "cursor"])).toThrow();
    expect(() => parseInitArgs(["--remote"])).toThrow("unknown init option: --remote");
  });
});
