import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import { checkForUpdate, compareVersions, describeUpdate, installedVersion, registryFetchLatest, REGISTRY_LATEST_URL, updateAvailable } from "../src/update-check.ts";
import { tempHome } from "./helpers.ts";

const latest = (version: string) => async () => version;

describe("compareVersions", () => {
  test.each([
    ["0.2.0", "0.3.0", -1],
    ["0.2.0", "0.2.0", 0],
    ["0.10.0", "0.9.0", 1],
    ["1.0.0-beta.1", "1.0.0", -1],
    ["1.0.0-beta.2", "1.0.0-beta.10", -1],
    ["1.0.0-alpha", "1.0.0-alpha.1", -1],
    ["v1.2.3", "1.2.3+build.5", 0],
  ])("%s vs %s is %i", (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });

  test("returns null for a version that is not semver", () => {
    expect(compareVersions("0.2.0", "latest")).toBeNull();
  });
});

describe("checkForUpdate", () => {
  test("outdated install reports update_available true", async () => {
    const check = await checkForUpdate("0.2.0", latest("0.3.1"));
    expect(check).toEqual({ status: "outdated", installed: "0.2.0", latest: "0.3.1" });
    expect(updateAvailable(check)).toBe(true);
    expect(describeUpdate(check)).toBe("outsrc 0.2.0 is installed; 0.3.1 is available. Upgrade with: npm install -g outsrc@latest");
  });

  test("current install reports update_available false", async () => {
    const check = await checkForUpdate("0.3.1", latest("0.3.1"));
    expect(check).toEqual({ status: "current", installed: "0.3.1", latest: "0.3.1" });
    expect(updateAvailable(check)).toBe(false);
    expect(describeUpdate(check)).toBe("outsrc 0.3.1 is the latest version.");
  });

  test("a local build ahead of npm reports update_available false", async () => {
    const check = await checkForUpdate("0.4.0", latest("0.3.1"));
    expect(check).toEqual({ status: "ahead", installed: "0.4.0", latest: "0.3.1" });
    expect(updateAvailable(check)).toBe(false);
  });

  test("a prerelease of the latest version is outdated", async () => {
    expect(updateAvailable(await checkForUpdate("0.3.1-rc.1", latest("0.3.1")))).toBe(true);
  });

  test("a network failure fails soft as unknown with update_available false", async () => {
    const check = await checkForUpdate("0.2.0", async () => { throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org"); });
    expect(check).toEqual({ status: "unknown", installed: "0.2.0", latest: null, error: "getaddrinfo ENOTFOUND registry.npmjs.org" });
    expect(updateAvailable(check)).toBe(false);
    expect(describeUpdate(check)).toBe("outsrc 0.2.0 is installed; could not check for updates (getaddrinfo ENOTFOUND registry.npmjs.org).");
  });

  test("an unparseable registry version fails soft as unknown", async () => {
    expect(await checkForUpdate("0.2.0", latest("not-a-version"))).toEqual({
      status: "unknown", installed: "0.2.0", latest: null, error: "cannot compare versions 0.2.0 and not-a-version",
    });
  });
});

describe("registryFetchLatest", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  test("reads version from the npm registry latest document", async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify({ name: "outsrc", version: "0.5.0" })));
    vi.stubGlobal("fetch", fetchMock);
    expect(await registryFetchLatest()()).toBe("0.5.0");
    expect(fetchMock.mock.calls[0]?.[0]).toBe(REGISTRY_LATEST_URL);
  });

  test("an HTTP error from the registry becomes unknown", async () => {
    vi.stubGlobal("fetch", async () => new Response("down", { status: 503 }));
    expect(await checkForUpdate("0.2.0", registryFetchLatest())).toEqual({
      status: "unknown", installed: "0.2.0", latest: null, error: "registry returned HTTP 503",
    });
  });

  test("a registry body without a version becomes unknown", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "Not found" })));
    const check = await checkForUpdate("0.2.0", registryFetchLatest());
    expect(check.status).toBe("unknown");
    expect(updateAvailable(check)).toBe(false);
  });
});

test("installedVersion reads the package.json version", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  expect(installedVersion()).toBe(pkg.version);
});

describe("outsrc doctor", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const installed = installedVersion();

  // Replaces fetch in the CLI process so doctor never reaches the real registry.
  function doctor(fetchBody: string, args: string[] = []) {
    const home = tempHome();
    writeFileSync(join(home, "config.toml"), "[targets.node]\nadapter = \"custom\"\ncommand = \"node\"\n");
    const stub = `data:text/javascript,globalThis.fetch=async()=>{${fetchBody}}`;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--import", stub, "src/cli.ts", "doctor", ...args], {
      cwd: root, env: { ...process.env, OUTSRC_HOME: home }, encoding: "utf8",
    });
    return { json: JSON.parse(result.stdout) as Record<string, unknown>, stderr: result.stderr, status: result.status };
  }

  test("reports update_available true with installed and latest versions when npm is newer", () => {
    const { json, stderr, status } = doctor('return new Response(JSON.stringify({version:"999.0.0"}))');
    expect(json.update_available).toBe(true);
    expect(json.version).toEqual({ status: "outdated", installed, latest: "999.0.0" });
    expect(stderr).toBe(`outsrc ${installed} is installed; 999.0.0 is available. Upgrade with: npm install -g outsrc@latest\n`);
    expect(status).toBe(0);
  });

  test("reports update_available false and prints no human line with --json when current", () => {
    const { json, stderr } = doctor(`return new Response(JSON.stringify({version:"${installed}"}))`, ["--json"]);
    expect(json.update_available).toBe(false);
    expect(json.version).toEqual({ status: "current", installed, latest: installed });
    expect(stderr).toBe("");
  });

  test("still reports and exits 0 when the registry is unreachable", () => {
    const { json, stderr, status } = doctor('throw new Error("offline")');
    expect(json.update_available).toBe(false);
    expect(json.version).toEqual({ status: "unknown", installed, latest: null, error: "offline" });
    expect(stderr).toBe(`outsrc ${installed} is installed; could not check for updates (offline).\n`);
    expect(status).toBe(0);
  });
});
