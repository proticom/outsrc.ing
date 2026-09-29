import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const USAGE = `Usage:
  node scripts/codex-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]
  node scripts/codex-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]
  node scripts/codex-companion.mjs task [--background] [--write] [--resume-last|--resume|--fresh] [--model <model>] [--effort <low|high>] [prompt]
  node scripts/codex-companion.mjs status [job-id] [--json]
  node scripts/codex-companion.mjs cancel [job-id] [--json]
`;
if (process.argv[2] === "--help") {
  process.stdout.write(USAGE);
  process.exit(0);
}
const data = process.env.CLAUDE_PLUGIN_DATA;
if (!data) process.exit(2);
mkdirSync(data, { recursive: true });
const args = process.argv.slice(2);
appendFileSync(join(data, "calls.jsonl"), `${JSON.stringify({ args, session: process.env.CODEX_COMPANION_SESSION_ID, cwd: process.cwd() })}\n`);
const [command] = args;
const prompt = args.at(-1) ?? "";

if (command === "task") {
  if (prompt.startsWith("SLEEP")) await new Promise((resolve) => setTimeout(resolve, 30_000));
  const rawOutput = args.includes("--resume-last")
    ? `Applied answer: ${prompt.split("\n")[0]}`
    : "NEEDS_INPUT: Which color should I use?";
  process.stdout.write(JSON.stringify({ status: 0, threadId: "fake-codex-thread", rawOutput, touchedFiles: [] }));
} else if (command === "adversarial-review") {
  process.stdout.write(JSON.stringify({
    review: "Adversarial Review",
    threadId: "fake-review-thread",
    codex: { status: 0, stderr: "", stdout: "" },
    result: {
      verdict: "needs-attention",
      summary: "One defect.",
      findings: [{ severity: "high", title: "Division by zero", body: "div(1, 0) raises.", file: "m.py", line_start: 2, line_end: 2, confidence: 0.9, recommendation: "Guard b == 0." }],
      next_steps: ["Add a zero check"],
    },
  }));
} else if (command === "status") {
  process.stdout.write(JSON.stringify({ workspaceRoot: args[args.indexOf("--cwd") + 1], jobs: [] }));
} else if (command === "cancel") {
  process.stdout.write(JSON.stringify({ cancelled: true }));
} else {
  process.exit(2);
}
