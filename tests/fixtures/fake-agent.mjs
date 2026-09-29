import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const [mode, sessionFlag, sessionId, prompt] = process.argv.slice(2);
if (sessionFlag !== "--session" || typeof prompt !== "string") process.exit(2);
if (sessionId && sessionId !== "fixture-session") process.exit(2);

function result(kind, message, findings = []) {
  process.stdout.write(JSON.stringify({ kind, message, sessionId: "fixture-session", findings }));
}

if (mode === "review") {
  result("completed", "Review completed", [{
    priority: "P2",
    title: "Missing empty-input case",
    body: "The fixture parser does not handle an empty input.",
    path: "parser.ts",
    line: 12,
  }]);
} else if (mode === "fail") {
  writeFileSync("task.txt", "partial result\n");
  result("completed", "Process will fail");
  process.exitCode = 2;
} else if (mode === "question" && !sessionId) {
  result("needs_input", "Which color should the result use?");
} else if (mode === "question") {
  if (!prompt.includes("green")) process.exit(2);
  writeFileSync("answer.txt", "green\n");
  result("completed", "Applied the answer: green");
} else {
  if (mode === "dumpenv") writeFileSync("env-keys.txt", Object.keys(process.env).sort().join("\n"));
  if (mode === "sleep") {
    process.stderr.write("Fixture started\n");
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  if (mode === "setup" && (!existsSync("setup-ready.txt") || readFileSync("setup-ready.txt", "utf8") !== "ready")) {
    process.stderr.write("Setup prerequisite is missing\n");
    process.exit(2);
  }
  const count = existsSync("invocations.txt") ? Number(readFileSync("invocations.txt", "utf8")) : 0;
  writeFileSync("invocations.txt", String(count + 1));
  writeFileSync("task.txt", sessionId ? "follow-up result\n" : "task result\n");
  if (mode === "commit") {
    execFileSync("git", ["add", "task.txt", "invocations.txt"]);
    execFileSync("git", ["commit", "-m", "Fixture task"]);
  }
  result("completed", sessionId ? "Follow-up completed" : "Task completed");
}
