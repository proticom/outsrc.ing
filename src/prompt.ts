import type { TaskKind } from "./types.js";

const instructions: Record<TaskKind, string> = {
  task: "Complete the requested task. Describe the result and the checks you performed.",
  review: "Review the requested code. Return concrete findings with priority, path and line when known. Do not edit files for this review.",
  adversarial_review: "Challenge the implementation's assumptions and exercise failure cases. Return concrete findings with priority, path and line when known. Do not edit files for this review.",
};
const TEXT_TASK = [
  "Do not open a pull request or push.",
  'If you need a decision from the requester before you can continue, make the first line of your final message "NEEDS_INPUT: " followed by the question, then stop. The answer will arrive by resuming this session.',
].join("\n\n");

export function wrapMessage(message: string, kind: TaskKind = "task", format: "json" | "text" = "json"): string {
  if (format === "text") return [message.trim(), instructions[kind], ...(kind === "task" ? [TEXT_TASK] : [])].join("\n\n");
  return [
    message.trim(),
    instructions[kind],
    "Do not open a pull request or push. Do not create SUMMARY.md.",
    'Return the requested JSON result. Use kind="completed" with a final message and findings (an empty array when there are none).',
    'If you need a decision, return kind="needs_input" with the question in message and an empty findings array, then end this run. The reply will arrive by resuming this session.',
  ].join("\n\n");
}
