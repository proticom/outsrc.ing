import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const data = process.env.CLAUDE_PLUGIN_DATA;
if (!data || process.argv[2] !== "SessionEnd") process.exit(2);
mkdirSync(data, { recursive: true });
const input = JSON.parse(readFileSync(0, "utf8"));
appendFileSync(join(data, "calls.jsonl"), `${JSON.stringify({ hook: process.argv[2], input })}\n`);
