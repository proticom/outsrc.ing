export type Rule =
  | "todo-without-link"
  | "suppression-without-reason"
  | "commented-out-code"
  | "excuse-marker"
  | "restates-code"
  | "unowned-constraint";

export interface DiffFile {
  path: string;
  lines: { line: number; text: string; added: boolean }[];
}

export interface Comment {
  kind: "line" | "block";
  startLine: number;
  endLine: number;
  lines: { line: number; text: string }[];
  text: string;
  standalone: boolean;
  nextCode: string;
  exportedJsdoc: boolean;
}

export interface Finding {
  path: string;
  line: number;
  rule: Rule;
  message: string;
}

export function parseUnifiedDiff(diff: string): DiffFile[];
export function extractComments(path: string, source: string): Comment[];
export function classifyComment(comment: Comment, line?: Comment["lines"][number]): Rule[];
export function lintDiff(diff: string, sources?: Readonly<Record<string, string>>): Finding[];
