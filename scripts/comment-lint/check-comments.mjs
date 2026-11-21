import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const slashExtensions = new Set("js mjs cjs jsx ts tsx mts cts swift rs go java kt kts c h cpp cs scss".split(" "));
const hashExtensions = new Set("py rb sh bash zsh yml yaml toml".split(" "));
const markupExtensions = new Set(["html", "vue", "svelte"]);
const issueLink = /https?:\/\/[^\s]*(?:\/issues\/|\/pull\/|\/discussions\/)|https?:\/\/(?:www\.)?rfc-editor\.org(?:\/|\b)|\bRFC\s+\d+\b/i;
const messages = {
  "todo-without-link": "Link this task to an issue or RFC.",
  "suppression-without-reason": "Name the suppressed rule or code and explain why it is suppressed.",
  "commented-out-code": "Delete commented-out code; git retains its history.",
  "excuse-marker": "Encode the constraint in code or link to the tracked work.",
  "restates-code": "Delete the comment that repeats the next code line.",
  "unowned-constraint": "Name an owner or link the external constraint.",
};

function diffPath(value) {
  const path = value.split("\t")[0];
  if (!path.startsWith('"')) return path.replace(/^b\//, "");
  const bytes = [];
  const escapes = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
  for (const part of path.slice(1, -1).matchAll(/\\([0-7]{1,3}|.)|[^\\]+/g)) {
    if (!part[1]) bytes.push(...Buffer.from(part[0]));
    else if (/^[0-7]+$/.test(part[1])) bytes.push(parseInt(part[1], 8));
    else bytes.push(escapes[part[1]] ?? part[1].charCodeAt(0));
  }
  return Buffer.from(bytes).toString("utf8").replace(/^b\//, "");
}

export function parseUnifiedDiff(diff) {
  const files = [];
  let file;
  let line = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  for (const raw of diff.split(/\r?\n/)) {
    if (raw.startsWith("diff --git ")) {
      file = undefined;
      oldRemaining = newRemaining = 0;
    } else if (oldRemaining || newRemaining) {
      if (raw.startsWith("+")) {
        file?.lines.push({ line: line++, text: raw.slice(1), added: true });
        newRemaining--;
      } else if (raw.startsWith("-")) oldRemaining--;
      else if (raw.startsWith(" ")) {
        file?.lines.push({ line: line++, text: raw.slice(1), added: false });
        oldRemaining--;
        newRemaining--;
      }
    } else if (raw.startsWith("+++ ")) {
      const path = diffPath(raw.slice(4));
      file = path === "/dev/null" ? undefined : { path, lines: [] };
      if (file) files.push(file);
    } else {
      const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
      if (!hunk) continue;
      oldRemaining = Number(hunk[1] ?? 1);
      line = Number(hunk[2]);
      newRemaining = Number(hunk[3] ?? 1);
    }
  }
  return files;
}

function syntax(path) {
  const extension = extname(path).slice(1).toLowerCase();
  if (slashExtensions.has(extension)) return "slash";
  if (hashExtensions.has(extension)) return "hash";
  if (markupExtensions.has(extension)) return "markup";
  return extension === "css" ? "css" : undefined;
}

function skipped(path, source) {
  return !syntax(path)
    || /(?:^|\/)(?:node_modules|dist|build|out|coverage|vendor|\.next)(?:\/|$)/.test(path)
    || /(?:^|\/)(?:[^/]*\.lock(?:\.[^/]*)?|[^/]*-lock\.[^/]*|yarn\.lock|lockfiles?)(?:\/|$)|\.(?:min\.js|map)$/.test(path)
    || /[\0-\x08\x0e-\x1f]/.test(source);
}

export function extractComments(path, source) {
  const style = syntax(path);
  if (!style) return [];
  const sourceLines = source.split(/\r?\n/);
  const code = sourceLines.map(() => "");
  const comments = [];
  let block;
  let quote = "";
  let escaped = false;
  let inTag = false;
  for (let index = 0; index < sourceLines.length; index++) {
    const text = sourceLines[index];
    let position = 0;
    if (block) block.lines.push({ line: index + 1, text: "" });
    while (position < text.length) {
      if (block) {
        const end = text.indexOf(block.close, position);
        block.lines.at(-1).text += text.slice(position, end < 0 ? text.length : end);
        if (end < 0) break;
        position = end + block.close.length;
        block.endLine = index + 1;
        block = undefined;
      } else if (quote) {
        if (escaped) { escaped = false; position++; }
        else if (text[position] === "\\") { escaped = true; position++; }
        else if (text.startsWith(quote, position)) { position += quote.length; quote = ""; }
        else position++;
      } else {
        const tail = text.slice(position);
        const slashComment = style === "slash" && tail.startsWith("//") && !/[\\:]/.test(text[position - 1] ?? "");
        const lineComment = slashComment || (style === "hash" && tail.startsWith("#"));
        const close = style === "markup" && tail.startsWith("<!--") ? "-->"
          : (style === "slash" || style === "css") && tail.startsWith("/*") && text[position - 1] !== "\\" ? "*/" : "";
        if (lineComment || close) {
          const width = lineComment ? (style === "hash" ? 1 : 2) : close === "-->" ? 4 : 2;
          const comment = {
            kind: lineComment ? "line" : "block", startLine: index + 1, endLine: index + 1,
            lines: [{ line: index + 1, text: "" }], close,
            jsdoc: tail.startsWith("/**"), standalone: !code[index].trim(),
          };
          comments.push(comment);
          position += width;
          if (lineComment) { comment.lines[0].text = text.slice(position); break; }
          block = comment;
        } else if ((style !== "markup" || inTag) && /["'`]/.test(text[position])) {
          quote = style === "hash" && (tail.startsWith('"""') || tail.startsWith("'''")) ? tail.slice(0, 3) : text[position];
          code[index] += '""';
          position += quote.length;
        } else {
          if (style === "markup" && text[position] === "<") inTag = true;
          if (style === "markup" && text[position] === ">") inTag = false;
          code[index] += text[position++];
        }
      }
    }
    if (quote.length === 1 && quote !== "`" && !escaped) quote = "";
    escaped = false;
  }
  return comments.map((comment) => {
    const lines = comment.lines.map(({ line, text }) => ({ line, text: text.replace(/^\s*\* ?/, "").trim() }));
    const nextCode = code.slice(comment.endLine).find((text) => text.trim()) ?? "";
    return {
      kind: comment.kind, startLine: comment.startLine, endLine: lines.at(-1).line, lines,
      text: lines.map(({ text }) => text).join("\n"),
      standalone: comment.standalone && !code[comment.endLine - 1].trim(), nextCode,
      exportedJsdoc: comment.jsdoc && /^\s*export\b/.test(sourceLines.slice(lines.at(-1).line).find((text) => text.trim()) ?? ""),
    };
  });
}

function suppression(text) {
  const eslint = /\beslint-disable(?:-next-line|-line)?\b([^\n]*)/.exec(text);
  if (eslint) return /^[\s]+[\w@/.-]+(?:\s*,\s*[\w@/.-]+)*\s+--\s+\S/.test(eslint[1]) ? "allowed" : "invalid";
  const biome = /\bbiome-ignore\b([^\n]*)/.exec(text);
  if (biome) return /^\s+[\w/.-]+(?:\s*,\s*[\w/.-]+)*\s*:\s*\S/.test(biome[1]) ? "allowed" : "invalid";
  const ts = /@ts-(ignore|expect-error)\b([^\n]*)/.exec(text);
  if (ts) return ts[2].replace(/^\s*(?::|--)?\s*/, "").trim() ? "allowed" : "invalid";
  const noqa = /\bnoqa\b([^\n]*)/i.exec(text);
  if (noqa) return /^\s*:\s*[A-Z]+\d+\b/i.test(noqa[1]) ? "valid" : "invalid";
  const typeIgnore = /\btype:\s*ignore\b([^\n]*)/.exec(text);
  if (typeIgnore) return /^\s*\[\s*[\w-]+(?:\s*,\s*[\w-]+)*\s*\]/.test(typeIgnore[1]) ? "valid" : "invalid";
  return "none";
}

function allowlisted(comment) {
  const text = comment.text;
  const constraint = /\bdo not (?:remove|change)\b|\btalk to .+? before\b/i.test(text);
  const owner = /@[\w-]+|\b(?:owner|team)\s*:\s*\S/.test(text)
    || /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:owns|maintains|approved|requires|depends)\b|\b(?:by|contact|ask)\s+[A-Z][a-z]+|[,(-]\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*(?=\s*(?:[),.;]|$))/.test(text)
    || /\b(?!the\b|a\b|our\b|this\b|your\b|remove\b|change\b)[\w-]+\s+team\b/i.test(text)
    || /\btalk to\s+[A-Z][\w-]*(?:\s+[A-Z][\w-]*)*\s+before\b/.test(text);
  return issueLink.test(text) || /\b[A-Z][A-Z0-9]+-\d+\b/.test(text)
    || (comment.startLine <= 20 && /SPDX-License-Identifier|Copyright|Licensed under/i.test(text))
    || comment.exportedJsdoc
    || /\bprettier-ignore\b|\b(?:istanbul|c8) ignore\b/.test(text)
    || /^!|^-\*- coding\b|^\s*(?:swift-tools-version|go:build)\b|^\/\s*<reference\b/.test(text)
    || suppression(text) === "allowed"
    || (constraint && (owner || /https?:\/\/\S+/.test(text)));
}

function looksLikeCode(text) {
  return !/[.!?]$/.test(text) && (/[;{}]$/.test(text)
    || /^(?:(?:const|let|var|import|return|function|await|export)\b|(?:if|for)\s*\(|console\.)/.test(text));
}

export function classifyComment(comment, line) {
  if (allowlisted(comment)) return [];
  if (!line) return [...new Set(comment.lines.flatMap((part) => classifyComment(comment, part)))];
  const text = line.text;
  const rules = [];
  if (/\b(?:TODO|FIXME|HACK|XXX)\b/i.test(text)) rules.push("todo-without-link");
  if (suppression(text) === "invalid") rules.push("suppression-without-reason");
  if (looksLikeCode(text)) rules.push("commented-out-code");
  if (/\b(?:temporary|temporarily|workaround|work around|for now|fine for now|too risky|quick fix|hack)\b/i.test(text)) rules.push("excuse-marker");
  if (/\bdo not (?:remove|change)\b|\btalk to .+? before\b/i.test(text)) rules.push("unowned-constraint");
  if (comment.startLine === comment.endLine && comment.standalone) {
    const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
    const identifiers = comment.nextCode.replace(/([a-z\d])([A-Z])/g, "$1 $2").replace(/([A-Z])([A-Z][a-z])/g, "$1 $2").toLowerCase().match(/[a-z]+/g) ?? [];
    if (comment.nextCode.includes("++")) identifiers.push("increment");
    if (comment.nextCode.includes("--")) identifiers.push("decrement");
    if (words.length > 0 && words.length <= 5 && words.every((word) => identifiers.includes(word))) rules.push("restates-code");
  }
  return rules;
}

function lintFile(path, source, added) {
  if (skipped(path, source)) return [];
  const comments = extractComments(path, source);
  if (comments.some((comment) => comment.startLine <= 20 && /@generated|DO NOT EDIT/.test(comment.text))) return [];
  const findings = [];
  let previousCodeLine = -2;
  let codeRunReported = false;
  for (const comment of comments) {
    for (const line of comment.lines) {
      const rules = classifyComment(comment, line);
      const code = rules.includes("commented-out-code");
      if (!code || previousCodeLine !== line.line - 1) codeRunReported = false;
      for (const rule of rules) {
        if (added && !added.has(line.line)) continue;
        if (rule === "commented-out-code") {
          if (codeRunReported) continue;
          codeRunReported = true;
        }
        findings.push({ path, line: line.line, rule, message: messages[rule] });
      }
      if (code) previousCodeLine = line.line;
    }
  }
  return findings;
}

export function lintDiff(diff, sources = {}) {
  return parseUnifiedDiff(diff).flatMap((file) => {
    const lines = sources[file.path]?.split(/\r?\n/) ?? [];
    for (const line of file.lines) lines[line.line - 1] = line.text;
    return lintFile(file.path, lines.join("\n"), new Set(file.lines.filter((line) => line.added).map((line) => line.line)));
  });
}

function options(args) {
  const result = { mode: "warn", format: process.env.GITHUB_ACTIONS === "true" ? "github" : "text" };
  const names = new Set(["--base", "--head", "--diff-file", "--mode", "--format"]);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--all") result.all = true;
    else if (names.has(args[i]) && args[i + 1] && !args[i + 1].startsWith("--")) result[args[i].slice(2)] = args[++i];
    else throw new Error(`Unknown option or missing value: ${args[i]}`);
  }
  if (!["warn", "error"].includes(result.mode)) throw new Error("--mode must be warn or error");
  if (!["github", "text", "json"].includes(result.format)) throw new Error("--format must be github, text, or json");
  const scopes = Number(Boolean(result.all)) + Number(Boolean(result["diff-file"])) + Number(Boolean(result.base || result.head));
  if (scopes !== 1 || (Boolean(result.base) !== Boolean(result.head))) throw new Error("Choose --all, --diff-file <path>, or --base <ref> --head <ref>");
  return result;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function escapeAnnotation(value, property = false) {
  let escaped = String(value).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  if (property) escaped = escaped.replaceAll(":", "%3A").replaceAll(",", "%2C");
  return escaped;
}

function report(findings, { mode, format }) {
  if (format === "json") process.stdout.write(`${JSON.stringify(findings, null, 2)}\n`);
  else if (format === "github") {
    for (const finding of findings) process.stdout.write(`::${mode === "error" ? "error" : "warning"} file=${escapeAnnotation(finding.path, true)},line=${finding.line},title=comment-lint/${finding.rule}::${escapeAnnotation(finding.message)}\n`);
  } else {
    for (const finding of findings) process.stdout.write(`${finding.path}:${finding.line}: ${finding.rule}: ${finding.message}\n`);
    process.stdout.write(`comment-lint: ${findings.length} finding(s)\n`);
  }
  if (format === "github" && process.env.GITHUB_STEP_SUMMARY) {
    const counts = new Map();
    for (const { rule } of findings) counts.set(rule, (counts.get(rule) ?? 0) + 1);
    const rows = [...counts].map(([rule, count]) => `| ${rule} | ${count} |`);
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### Comment lint\n\n${findings.length} finding(s), mode ${mode}.\n\n| Rule | Findings |\n| --- | ---: |\n${rows.length ? rows.join("\n") : "| None | 0 |"}\n`);
  }
}

function main() {
  let config;
  try {
    config = options(process.argv.slice(2));
    let findings;
    if (config.all) {
      findings = git(["ls-files", "-z"]).split("\0").filter(Boolean).flatMap((path) => {
        if (skipped(path, "")) return [];
        try { return lintFile(path, readFileSync(path, "utf8")); }
        catch (error) { if (error.code === "ENOENT") return []; throw error; }
      });
    } else {
      const diff = config["diff-file"] ? readFileSync(config["diff-file"], "utf8")
        : git(["diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", config.base, config.head, "--"]);
      const sources = Object.create(null);
      if (!config["diff-file"]) {
        for (const { path } of parseUnifiedDiff(diff)) {
          if (!skipped(path, "")) sources[path] = git(["show", `${config.head}:${path}`]);
        }
      }
      findings = lintDiff(diff, sources);
    }
    report(findings, config);
    process.exitCode = config.mode === "error" && findings.length > 0 ? 1 : 0;
  } catch (error) {
    process.stderr.write(`comment-lint: ${error.message}\n`);
    process.exitCode = (config?.mode ?? (process.argv.includes("error") ? "error" : "warn")) === "error" ? 1 : 0;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
