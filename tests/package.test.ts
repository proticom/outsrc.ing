import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

// npm publish silently drops bin entries it considers invalid, which ships a package with no commands.
test("each bin entry is a plain path to a built file whose source starts with a node shebang", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { bin: Record<string, string> };
  expect(pkg.bin).toEqual({ "outsrc-mcp": "dist/server.js", outsrc: "dist/cli.js" });
  for (const target of Object.values(pkg.bin)) {
    const source = target.replace(/^dist\//, "src/").replace(/\.js$/, ".ts");
    expect(readFileSync(new URL(`../${source}`, import.meta.url), "utf8").split("\n")[0]).toBe("#!/usr/bin/env node");
  }
});

test("the MCP server starts when launched through a symlink, the way npm installs outsrc-mcp", async () => {
  const { mkdtempSync, symlinkSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const dir = mkdtempSync(join(tmpdir(), "outsrc-bin-"));
  writeFileSync(join(dir, "config.toml"), '[targets.claude]\nadapter = "claude"\ncommand = "claude"\n');
  const link = join(dir, "outsrc-mcp");
  symlinkSync(fileURLToPath(new URL("../src/server.ts", import.meta.url)), link);
  const client = new Client({ name: "package-test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: ["--import", "tsx", link, "--caller", "test"], env: { OUTSRC_HOME: dir }, stderr: "pipe",
    cwd: fileURLToPath(new URL("..", import.meta.url)),
  }));
  try {
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("send");
  } finally {
    await client.close();
  }
});
