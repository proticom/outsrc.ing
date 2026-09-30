import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, test } from "vitest";

test("stdio exposes tools, reads config, and validates input", async () => {
  const home = mkdtempSync(join(tmpdir(), "outsrc-mcp-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/server.ts"],
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { OUTSRC_HOME: home },
  });
  const client = new Client({ name: "outsrc-test", version: "1.0.0" });

  try {
    writeFileSync(
      join(home, "config.toml"),
      '[[repos]]\nalias = "demo"\npath = "/tmp/outsrc-demo"\n',
    );
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "diff",
      "discard",
      "history",
      "inbox",
      "list_repos",
      "list_targets",
      "log",
      "send",
      "settings",
      "stop",
      "threads",
      "usage",
    ]);

    const repos = await client.callTool({ name: "list_repos", arguments: {} });
    expect(repos.content).toEqual([
      {
        type: "text",
        text: '{\n  "repos": [\n    {\n      "alias": "demo",\n      "path": "/tmp/outsrc-demo"\n    }\n  ]\n}',
      },
    ]);

    const invalid = await client.callTool({
      name: "send",
      arguments: { message: 42 },
    });
    expect(invalid).toMatchObject({
      isError: true,
      content: [
        {
          type: "text",
          text: expect.stringContaining(
            "Input validation error: Invalid arguments for tool send",
          ),
        },
      ],
    });
  } finally {
    try {
      await transport.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});
