import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";
import { classifyComment, extractComments, lintDiff, parseUnifiedDiff } from "../scripts/comment-lint/check-comments.mjs";

function addedDiff(source: string, path = "lint-fixture.ts") {
  const lines = source.split("\n");
  return `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`;
}

function rules(source: string, path = "lint-fixture.ts") {
  return lintDiff(addedDiff(source, path)).map(({ rule }) => rule);
}

test.each(["TODO", "FIXME", "HACK", "XXX"])("flags %s without a link", (marker) => {
  expect(rules(`// ${marker} investigate`)).toContain("todo-without-link");
});

test.each([
  "// eslint-disable",
  "// eslint-disable -- legacy input",
  "// eslint-disable-next-line no-alert",
  "// eslint-disable-line no-alert --",
  "// @ts-ignore",
  "// @ts-ignore:",
  "// @ts-expect-error",
  "// @ts-expect-error --",
  "// biome-ignore lint/style/noVar:",
  "// biome-ignore",
])("requires a suppression reason in %s", (source) => {
  expect(rules(source)).toEqual(["suppression-without-reason"]);
});

test.each(["# noqa", "# noqa:", "# type: ignore", "# type: ignore[]"])("requires a Python suppression code in %s", (source) => {
  expect(rules(source, "lint-fixture.py")).toEqual(["suppression-without-reason"]);
});

test.each(["temporary", "temporarily", "workaround", "work around", "for now", "fine for now", "too risky", "quick fix", "hack", "TEMPORARY"])("flags excuse marker %s", (marker) => {
  expect(rules(`// ${marker} until release`)).toContain("excuse-marker");
});

test("matches whole words and ignores prose ending in a period", () => {
  expect(rules("// The hackathon entry has a temporaryFile field.")).toEqual([]);
  expect(rules("// Return the stored value.")).toEqual([]);
});

test("tracker keys require uppercase letters", () => {
  expect(rules("// HACK sha-256 implementation")).toEqual(["todo-without-link", "excuse-marker"]);
});

test.each([
  "const result = load()", "let result = load()", "var result = load()", "import load", "return result",
  "if (ready)", "for (item of items)", "function run()", "await load()", "console.info(value)", "export const x = 1",
  "run(value);", "a = b;", "thing;", "{", "}",
])("detects code conservatively in %s", (source) => {
  expect(rules(`// ${source}`)).toEqual(["commented-out-code"]);
});

test("reports code once per consecutive run", () => {
  const findings = lintDiff(addedDiff("// const first = 1;\n// return first;\n\n// call();"));
  expect(findings.map(({ line, rule }) => ({ line, rule }))).toEqual([
    { line: 1, rule: "commented-out-code" },
    { line: 4, rule: "commented-out-code" },
  ]);
});

test("reports the first added code comment in an existing run", () => {
  const diff = '--- a/a.ts\n+++ b/a.ts\n@@ -2,0 +3,2 @@\n+// return first;\n+// call();\n';
  expect(lintDiff(diff, { "a.ts": "// const first = 1;\n// const second = 2;\n// return first;\n// call();" }).map(({ line, rule }) => ({ line, rule }))).toEqual([
    { line: 3, rule: "commented-out-code" },
  ]);
});

test.each([
  "// increment counter\ncounter++;",
  "// decrement counter\ncounter--;",
  "// get user\n\ngetUser();",
  "// get user\nget_user();",
  "/* get user */\ngetUser();",
])("detects a short restatement in %s", (source) => {
  expect(rules(source)).toEqual(["restates-code"]);
});

test.each([
  "// get missing user\ngetUser();",
  "// get the user before rendering this view\ngetTheUserBeforeRenderingThisView();",
  "getUser(); // get user\ngetUser();",
  "/* get\n * user */\ngetUser();",
  '// user\nprint("user");',
])("keeps comments outside the restatement heuristic in %s", (source) => {
  expect(rules(source)).toEqual([]);
});

test.each(["do not remove", "do not change", "talk to someone before editing", "do not remove, the team depends on this"])("flags an unowned constraint %s", (source) => {
  expect(rules(`// ${source}`)).toEqual(["unowned-constraint"]);
});

test.each([
  "// SPDX-License-Identifier: MIT; temporary",
  "// Copyright Example; TODO",
  "/* Licensed under MIT\n * TODO keep legal wording\n */",
  "// prettier-ignore temporary",
  "// biome-ignore lint/style/noVar: temporary vendor format",
  "// eslint-disable no-alert -- temporary vendor API",
  "// eslint-disable-next-line no-alert, no-console -- temporary diagnostics",
  "// eslint-disable-line @scope/rule -- temporary vendor API",
  "// @ts-ignore: vendor types omit this overload",
  "// @ts-expect-error: temporary vendor type mismatch",
  "// istanbul ignore next temporary",
  "// c8 ignore next temporary",
  "// swift-tools-version: 6.0 temporary",
  "//go:build linux temporary",
  '/// <reference path="temporary.ts" />',
  "/** TODO temporary public contract */\nexport function run() {}",
  "/**\n * TODO public contract\n */\n\nexport const value = 1;",
  "// TODO https://github.com/org/repo/issues/1",
  "// FIXME https://github.com/org/repo/pull/2",
  "// HACK https://github.com/org/repo/discussions/3",
  "// XXX https://www.rfc-editor.org/rfc/rfc9110",
  "// TODO RFC 9110",
  "// TODO ABC-123",
  "// do not remove, @payments owns this temporary constraint",
  "// do not change, owner: Alice",
  "// do not remove, Payments team maintains this",
  "// do not change, Payments Team depends on this format",
  "// do not remove, Alice approved this interface",
  "// do not remove, Alice",
  "// do not remove, platform team owns the interface",
  "// do not remove (Alice Smith)",
  "// talk to Alice before changing this temporary format",
  "// do not remove https://vendor.example/contract",
])("allows %s", (source) => {
  expect(rules(source)).toEqual([]);
});

test.each([
  "#!/bin/sh temporary", "# -*- coding: utf-8 -*- temporary", "# noqa: F401", "# type: ignore[arg-type]",
])("allows hash pragma %s", (source) => {
  expect(rules(source, "lint-fixture.py")).toEqual([]);
});

test("license allowance ends after the first twenty lines", () => {
  expect(rules(`${"\n".repeat(20)}// Copyright TODO`)).toEqual(["todo-without-link"]);
});

test("does not allow a JSDoc block on a private declaration", () => {
  expect(rules("/** TODO describe */\nfunction run() {} ")).toEqual(["todo-without-link"]);
});

test.each("js mjs cjs jsx ts tsx mts cts swift rs go java kt kts c h cpp cs scss".split(" "))("extracts slash comments in .%s", (extension) => {
  expect(rules('// TODO investigate\n/* FIXME investigate */', `lint-fixture.${extension}`)).toEqual(["todo-without-link", "todo-without-link"]);
});

test.each("py rb sh bash zsh yml yaml toml".split(" "))("extracts hash comments in .%s", (extension) => {
  expect(rules('value = "# TODO in a string"\n# TODO investigate', `lint-fixture.${extension}`)).toEqual(["todo-without-link"]);
});

test.each(["html", "vue", "svelte"])("extracts template comments in .%s", (extension) => {
  expect(rules('<p>TODO text</p>\n<!-- TODO investigate -->', `lint-fixture.${extension}`)).toEqual(["todo-without-link"]);
});

test("ignores comment markers in HTML attributes without hiding comments after prose", () => {
  expect(rules('<div title="<!-- TODO text -->">It\'s ready</div>\n<!-- TODO investigate -->', "lint-fixture.html")).toEqual(["todo-without-link"]);
});

test("CSS accepts only block comments", () => {
  expect(rules('// TODO ignored\n/* TODO investigate */', "lint-fixture.css")).toEqual(["todo-without-link"]);
});

test("ignores markers in strings and URLs", () => {
  const source = [
    'const url = "https://example.test/TODO";',
    'const escaped = "a \\\" // TODO still in the string";',
    "const single = '// TODO string';",
    "const template = `first\n// TODO string\nlast`;",
    'const source = target.replace(/^dist\\//, "src/");',
    '// This describes the protocol.',
  ].join("\n");
  expect(rules(source)).toEqual([]);
  expect(rules('value = """\n# TODO string\n"""', "lint-fixture.py")).toEqual([]);
});

test("extracts multiline blocks and retains their full text", () => {
  const comments = extractComments("lint-fixture.ts", "/*\n * TODO investigate\n * https://example.test/issues/1\n */\nload();");
  expect(comments.map(({ startLine, endLine, text, nextCode }) => ({ startLine, endLine, text, nextCode }))).toEqual([
    { startLine: 1, endLine: 4, text: "\nTODO investigate\nhttps://example.test/issues/1\n", nextCode: "load();" },
  ]);
  const comment = comments[0];
  if (!comment) throw new Error("Expected one block comment");
  expect(classifyComment(comment)).toEqual([]);
});

test("classifies all lines of a block when called directly", () => {
  const comment = extractComments("lint-fixture.ts", "/*\n * TODO investigate\n * temporary behavior\n */")[0];
  if (!comment) throw new Error("Expected one block comment");
  expect(classifyComment(comment)).toEqual(["todo-without-link", "excuse-marker"]);
});

test("handles multiple blocks and inline comments on one line", () => {
  expect(rules("/* TODO first */ work(); /* FIXME second */")).toEqual(["todo-without-link", "todo-without-link"]);
});

test.each([
  "node_modules/a.ts", "dist/a.ts", "build/a.ts", "out/a.ts", "coverage/a.ts", "vendor/a.ts", ".next/a.ts",
  "nested/node_modules/a.ts", "generated.min.js", "file.js.map", "package-lock.json", "deps.lock.ts", "README.md",
])("skips %s", (path) => {
  expect(rules("// TODO investigate", path)).toEqual([]);
});

test.each(["// @generated\n// TODO investigate", "/* DO NOT EDIT */\n// TODO investigate", "\0// TODO binary"])("skips generated or binary source %s", (source) => {
  expect(rules(source)).toEqual([]);
});

test("generated markers inside strings do not skip a file", () => {
  expect(rules('const marker = "@generated DO NOT EDIT";\n// TODO investigate')).toEqual(["todo-without-link"]);
});

test("parses hunks, deletions, context, quoted names, and new-file line numbers", () => {
  const diff = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -4,2 +4,2 @@\n-// TODO removed\n+// FIXME added\n keep();\n@@ -9,0 +10 @@\n+// XXX added\n\\ No newline at end of file\ndiff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"\n--- /dev/null\n+++ "b/caf\\303\\251.ts"\n@@ -0,0 +1 @@\n+// TODO named\n';
  expect(parseUnifiedDiff(diff)).toEqual([
    { path: "a.ts", lines: [{ line: 4, text: "// FIXME added", added: true }, { line: 5, text: "keep();", added: false }, { line: 10, text: "// XXX added", added: true }] },
    { path: "café.ts", lines: [{ line: 1, text: "// TODO named", added: true }] },
  ]);
  expect(lintDiff(diff).map(({ path, line, rule }) => ({ path, line, rule }))).toEqual([
    { path: "a.ts", line: 4, rule: "todo-without-link" },
    { path: "a.ts", line: 10, rule: "todo-without-link" },
    { path: "café.ts", line: 1, rule: "todo-without-link" },
  ]);
});

test("rename-with-edit findings use the new path", () => {
  const diff = 'diff --git a/old.ts b/new.ts\nsimilarity index 60%\nrename from old.ts\nrename to new.ts\n--- a/old.ts\n+++ b/new.ts\n@@ -1 +1,2 @@\n const value = 1;\n+// TODO investigate\n';
  expect(lintDiff(diff).map(({ path, line, rule }) => ({ path, line, rule }))).toEqual([
    { path: "new.ts", line: 2, rule: "todo-without-link" },
  ]);
});

test("binary diffs without hunks have no findings", () => {
  const diff = 'diff --git a/data.ts b/data.ts\nindex 1234567..abcdef0 100644\nBinary files a/data.ts and b/data.ts differ\n';
  expect(lintDiff(diff)).toEqual([]);
});

test("ignores existing TODOs in context and deleted lines", () => {
  const diff = '--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,3 @@\n // TODO existing\n-// FIXME removed\n+const value = 1;\n use(value);\n';
  expect(lintDiff(diff)).toEqual([]);
});

test("lints only added block lines using the complete target source", () => {
  const diff = '--- a/a.ts\n+++ b/a.ts\n@@ -2,0 +3,1 @@\n+ * TODO added\n';
  expect(lintDiff(diff, { "a.ts": "/*\n * FIXME existing\n * TODO added\n */" }).map(({ line, rule }) => ({ line, rule }))).toEqual([{ line: 3, rule: "todo-without-link" }]);
  expect(lintDiff(diff, { "a.ts": "/*\n * https://example.test/issues/1\n * TODO added\n */" })).toEqual([]);
});

test("uses full JSDoc and license blocks when only an interior line changes", () => {
  const diff = '--- a/a.ts\n+++ b/a.ts\n@@ -1,0 +2,1 @@\n+ * TODO added\n';
  expect(lintDiff(diff, { "a.ts": "/**\n * TODO added\n */\nexport const value = 1;" })).toEqual([]);
  expect(lintDiff(diff, { "a.ts": "/* Copyright Example\n * TODO added\n */" })).toEqual([]);
});

test("saved diff context supplies a block allowlist", () => {
  const diff = '--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,4 @@\n /* https://example.test/issues/1\n+ * TODO added\n  */\n run();\n';
  expect(lintDiff(diff)).toEqual([]);
});

test("a clean diff has no findings", () => {
  expect(lintDiff(addedDiff("export const sum = (a, b) => a + b;"))).toEqual([]);
  expect(lintDiff("")).toEqual([]);
  expect(lintDiff('--- a/a.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-// TODO removed\n')).toEqual([]);
});

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

const checker = fileURLToPath(new URL("../scripts/comment-lint/check-comments.mjs", import.meta.url));

function runChecker(source: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  const directory = mkdtempSync(join(tmpdir(), "comment-lint-"));
  temporaryDirectories.push(directory);
  const diffPath = join(directory, "change.diff");
  writeFileSync(diffPath, addedDiff(source));
  return spawnSync(process.execPath, [checker, "--diff-file", diffPath, ...args], {
    cwd: directory, encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "false", GITHUB_STEP_SUMMARY: "", ...env },
  });
}

test.each(["warn", "error"])("CLI uses %s exit status", (mode) => {
  const result = runChecker("// TODO investigate", ["--mode", mode, "--format", "json"]);
  expect(result.status).toBe(mode === "warn" ? 0 : 1);
  expect(JSON.parse(result.stdout)).toEqual([
    { path: "lint-fixture.ts", line: 1, rule: "todo-without-link", message: "Link this task to an issue or RFC." },
  ]);
  expect(result.stderr).toBe("");
});

test.each(["warn", "error"])("CLI exits 2 for invalid Git refs in %s mode", (mode) => {
  const directory = mkdtempSync(join(tmpdir(), "comment-lint-invalid-refs-"));
  temporaryDirectories.push(directory);
  expect(spawnSync("git", ["init", "--quiet", directory]).status).toBe(0);
  for (const actions of ["false", "true"]) {
    const result = spawnSync(process.execPath, [checker, "--mode", mode, "--base", "missing-base", "--head", "missing-head"], {
      cwd: directory, encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: actions, GITHUB_STEP_SUMMARY: "" },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("comment-lint: Command failed: git diff");
    expect(result.stderr).toContain("missing-base");
    if (actions === "true") expect(result.stdout).toContain("::error title=comment-lint::comment-lint failed: ");
    else expect(result.stdout).toBe("");
  }
});

test.each([
  { option: "--mode", message: "--mode must be warn or error" },
  { option: "--format", message: "--format must be github, text, or json" },
  { option: "--unknown", message: "Unknown option or missing value: --unknown" },
])("CLI exits 2 for invalid $option", ({ option, message }) => {
  const result = runChecker("run();", [option, "invalid"], { GITHUB_ACTIONS: "true" });
  expect(result.status).toBe(2);
  expect(result.stderr).toBe(`comment-lint: ${message}\n`);
  expect(result.stdout).toBe(`::error title=comment-lint::comment-lint failed: ${message}\n`);
});

test("CLI exits 2 for an unreadable diff in warn mode", () => {
  const result = runChecker("run();", ["--mode", "warn", "--diff-file", "missing.diff"]);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("comment-lint: ENOENT:");
  expect(result.stdout).toBe("");
});

test("real Git merge-base range excludes base-only changes", () => {
  const directory = mkdtempSync(join(tmpdir(), "comment-lint-range-"));
  temporaryDirectories.push(directory);
  function git(...args: string[]) {
    const result = spawnSync("git", ["-c", "user.name=Comment Lint Test", "-c", "user.email=comment-lint@example.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
      cwd: directory, encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  }
  git("init", "--quiet", "--initial-branch=base");
  writeFileSync(join(directory, "shared.ts"), "// TODO existing\nconst value = 1;\n");
  git("add", "--", "shared.ts");
  git("commit", "--quiet", "-m", "Initial fixture");
  git("checkout", "--quiet", "-b", "feature");
  writeFileSync(join(directory, "shared.ts"), "// TODO existing\nconst value = 1;\n// TODO branch addition\n");
  git("add", "--", "shared.ts");
  git("commit", "--quiet", "-m", "Branch fixture");
  git("checkout", "--quiet", "base");
  writeFileSync(join(directory, "shared.ts"), "const value = 1;\n");
  writeFileSync(join(directory, "base-only.ts"), "// FIXME base only\n");
  git("add", "--", "shared.ts", "base-only.ts");
  git("commit", "--quiet", "-m", "Advance base fixture");
  const mergeBase = git("merge-base", "base", "feature");
  const result = spawnSync(process.execPath, [checker, "--base", mergeBase, "--head", "feature", "--mode", "error", "--format", "json"], {
    cwd: directory, encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "false", GITHUB_STEP_SUMMARY: "" },
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual([
    { path: "shared.ts", line: 3, rule: "todo-without-link", message: "Link this task to an issue or RFC." },
  ]);
});

function fixtureGit(directory: string, ...args: string[]) {
  const result = spawnSync("git", ["-c", "user.name=Comment Lint Test", "-c", "user.email=comment-lint@example.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd: directory, encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function cloneFixture(blobless: boolean) {
  const directory = mkdtempSync(join(tmpdir(), "comment-lint-clone-"));
  temporaryDirectories.push(directory);
  const origin = join(directory, "origin");
  const clone = join(directory, "clone");
  fixtureGit(directory, "init", "--quiet", "--initial-branch=base", origin);
  fixtureGit(origin, "config", "uploadpack.allowFilter", "true");
  writeFileSync(join(origin, "existing.ts"), "const value = 1;\n");
  fixtureGit(origin, "add", "--", "existing.ts");
  fixtureGit(origin, "commit", "--quiet", "-m", "Initial fixture");
  const base = fixtureGit(origin, "rev-parse", "HEAD");
  const baseBlob = fixtureGit(origin, "rev-parse", `${base}:existing.ts`);
  fixtureGit(origin, "checkout", "--quiet", "-b", "feature");
  writeFileSync(join(origin, "existing.ts"), "const value = 2;\n// TODO investigate\n");
  fixtureGit(origin, "add", "--", "existing.ts");
  fixtureGit(origin, "commit", "--quiet", "-m", "Edit fixture");
  const head = fixtureGit(origin, "rev-parse", "HEAD");
  const cloned = spawnSync("git", ["clone", "--quiet", "--branch", "feature", ...(blobless ? ["--filter=blob:none", "--no-checkout"] : []), pathToFileURL(origin).href, clone], {
    cwd: directory, encoding: "utf8",
  });
  return { clone, base, head, baseBlob, cloned };
}

function lintCloneWithoutRemote({ clone, base, head }: ReturnType<typeof cloneFixture>) {
  fixtureGit(clone, "remote", "set-url", "origin", pathToFileURL(join(clone, "missing-origin")).href);
  const mergeBase = fixtureGit(clone, "merge-base", base, head);
  return spawnSync(process.execPath, [checker, "--mode", "warn", "--format", "text", "--base", mergeBase, "--head", head], {
    cwd: clone, encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "false", GITHUB_STEP_SUMMARY: "" },
  });
}

test("edits to an existing file lint without reaching the remote", () => {
  const fixture = cloneFixture(false);
  expect(fixture.cloned.status).toBe(0);
  const result = lintCloneWithoutRemote(fixture);
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe("existing.ts:2: todo-without-link: Link this task to an issue or RFC.\ncomment-lint: 1 finding(s)\n");
});

test("blobless clones with a broken promisor remote fail loudly", (context) => {
  const fixture = cloneFixture(true);
  if (fixture.cloned.status !== 0 && /filter.*(?:not supported|not recognized|unsupported)|(?:not support|unsupported|unknown|unrecognized).*filter/i.test(fixture.cloned.stderr)) {
    context.skip(`Local Git refused partial clone: ${fixture.cloned.stderr.trim()}`);
  }
  expect(fixture.cloned.status).toBe(0);
  const missing = fixtureGit(fixture.clone, "rev-list", "--objects", "--all", "--missing=print").split("\n");
  if (!missing.includes(`?${fixture.baseBlob}`)) context.skip("Local Git retained the base blob despite blob:none; missing-blob failure cannot be exercised");
  const result = lintCloneWithoutRemote(fixture);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("comment-lint:");
  expect(result.stderr).toContain("from promisor remote");
  expect(result.stdout).toBe("");
});

test("workflow does not use blob filters", () => {
  const workflow = readFileSync(new URL("../.github/workflows/comment-lint.yml", import.meta.url), "utf8");
  const filters = workflow.split("\n").filter((line) => /\bfilter['"]?\s*:\s*['"]?blob:none\b/.test(line) || /\bgit\s+fetch\b.*--filter=blob:none\b/.test(line));
  expect(filters).toEqual([]);
});

test("CLI defaults to warn and text outside Actions", () => {
  const result = runChecker("// TODO investigate");
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("lint-fixture.ts:1: todo-without-link: Link this task to an issue or RFC.\ncomment-lint: 1 finding(s)\n");
});

test("saved diff additions take precedence over local files", () => {
  const directory = mkdtempSync(join(tmpdir(), "comment-lint-saved-"));
  temporaryDirectories.push(directory);
  writeFileSync(join(directory, "lint-fixture.ts"), 'const value = "safe";');
  writeFileSync(join(directory, "saved.diff"), addedDiff("// TODO investigate"));
  const result = spawnSync(process.execPath, [checker, "--diff-file", "saved.diff", "--mode", "error", "--format", "text"], {
    cwd: directory, encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: "" },
  });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("lint-fixture.ts:1: todo-without-link: Link this task to an issue or RFC.\ncomment-lint: 1 finding(s)\n");
});

test.each(["warn", "error"])("clean CLI input succeeds in %s mode", (mode) => {
  const result = runChecker("run();", ["--mode", mode, "--format", "json"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("[]\n");
});

test("all scope checks tracked files and ignores untracked files", () => {
  const directory = mkdtempSync(join(tmpdir(), "comment-lint-all-"));
  temporaryDirectories.push(directory);
  expect(spawnSync("git", ["init", "--quiet", directory]).status).toBe(0);
  writeFileSync(join(directory, "tracked.ts"), "// TODO investigate");
  writeFileSync(join(directory, "generated.ts"), "// @generated\n// FIXME generated");
  expect(spawnSync("git", ["-C", directory, "add", "--", "tracked.ts", "generated.ts"]).status).toBe(0);
  writeFileSync(join(directory, "untracked.ts"), "// FIXME untracked");
  const result = spawnSync(process.execPath, [checker, "--all", "--format", "text"], {
    cwd: directory, encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: "" },
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("tracked.ts:1: todo-without-link: Link this task to an issue or RFC.\ncomment-lint: 1 finding(s)\n");
});

test("GitHub annotations escape filenames", () => {
  const directory = mkdtempSync(join(tmpdir(), "comment-lint-escape-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "escape.diff");
  writeFileSync(path, addedDiff("// TODO investigate", "odd%,name.ts"));
  const result = spawnSync(process.execPath, [checker, "--diff-file", path, "--format", "github"], {
    cwd: directory, encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: "" },
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("::warning file=odd%25%2Cname.ts,line=1,title=comment-lint/todo-without-link::Link this task to an issue or RFC.\n");
});

test("CLI emits GitHub annotations and appends a summary", () => {
  const directory = mkdtempSync(join(tmpdir(), "comment-lint-summary-"));
  temporaryDirectories.push(directory);
  const summary = join(directory, "summary.md");
  writeFileSync(summary, "Earlier step\n");
  const result = runChecker("// TODO investigate", [], { GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: summary });
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("::warning file=lint-fixture.ts,line=1,title=comment-lint/todo-without-link::Link this task to an issue or RFC.\n");
  expect(readFileSync(summary, "utf8")).toBe("Earlier step\n\n### Comment lint\n\n1 finding(s), mode warn.\n\n| Rule | Findings |\n| --- | ---: |\n| todo-without-link | 1 |\n");
  const error = runChecker("// TODO investigate", ["--mode", "error", "--format", "github"]);
  expect(error.status).toBe(1);
  expect(error.stdout).toBe("::error file=lint-fixture.ts,line=1,title=comment-lint/todo-without-link::Link this task to an issue or RFC.\n");
});
