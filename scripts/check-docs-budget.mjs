#!/usr/bin/env node
/**
 * A bug fix or internal change restores or keeps documented behavior, so it
 * may rewrite docs but not grow them. This check compares a branch with its
 * base: when the branch changes `packages/` and adds no `minor` or `major`
 * changeset, the lines it adds to `docs/` Markdown and to JSDoc in `packages/`
 * may not exceed the lines it deletes there.
 *
 *   node scripts/check-docs-budget.mjs            working tree vs merge base with main
 *   node scripts/check-docs-budget.mjs --staged   index vs merge base (pre-commit hook)
 *   node scripts/check-docs-budget.mjs --base <sha> [--head <sha>]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const SOURCE_RE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const DOCS_RE = /^docs\/.*\.mdx?$/;
const CHANGESET_RE = /^\.changeset\/(?!README\.md$)[^/]+\.md$/;
const JSDOC_LINE_RE = /^\s*(?:\/\*\*(?!\/)|\*(?!\/)|\*\/)/;

const require = createRequire(import.meta.url);
const ts = createRequire(require.resolve("@microsoft/api-extractor/package.json"))("typescript");
const printer = ts.createPrinter({ removeComments: true });

/**
 * @param {string} path
 * @param {string} text
 */
function printWithoutComments(path, text) {
  const kind = path.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : path.endsWith(".jsx")
      ? ts.ScriptKind.JSX
      : /\.[cm]?js$/.test(path)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  return printer
    .printFile(ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, kind))
    .replace(/\/\*![\s\S]*?\*\//g, "")
    .replace(/\s+/g, "");
}

/** @param {string[]} args */
function git(args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** @param {string} ref */
function hasRef(ref) {
  try {
    git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function defaultBase() {
  const target = ["origin/main", "main"].find(hasRef);
  if (target === undefined)
    throw new Error("Cannot find origin/main or main to compare against. Pass --base <sha>.");
  return git(["merge-base", "HEAD", target]).trim();
}

/**
 * @param {{ base: string; head?: string; staged?: boolean }} range
 */
function rangeArgs({ base, head, staged }) {
  if (head !== undefined) return [base, head];
  if (staged) return ["--cached", base];
  return [base];
}

/** @param {string} text */
function changesetBumps(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (match === null) return [];
  return [...match[1].matchAll(/^\s*["']?[^"':]+["']?\s*:\s*(major|minor|patch)\s*$/gm)].map(
    (item) => item[1],
  );
}

/**
 * Measures a change: which paths it touches, its docs and JSDoc line counts,
 * and whether a changeset marks it as a feature.
 *
 * @param {{ base: string; head?: string; staged?: boolean }} range
 */
export function measureDocsGrowth(range) {
  const args = rangeArgs(range);
  const untracked =
    range.head === undefined && !range.staged
      ? git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean)
      : [];
  const readFile = (path) => {
    if (range.head !== undefined) return git(["show", `${range.head}:${path}`]);
    if (range.staged) return git(["show", `:${path}`]);
    return readFileSync(join(root, path), "utf8");
  };

  const numstat = git(["diff", "--numstat", "--no-renames", ...args])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [added, deleted, path] = line.split("\t");
      return { path, added: Number(added) || 0, deleted: Number(deleted) || 0 };
    });
  const paths = [...numstat.map((item) => item.path), ...untracked];

  const docs = { added: 0, deleted: 0, files: new Map() };
  for (const item of numstat) {
    if (!DOCS_RE.test(item.path)) continue;
    docs.added += item.added;
    docs.deleted += item.deleted;
    docs.files.set(item.path, item.added - item.deleted);
  }

  const jsdoc = { added: 0, deleted: 0, files: new Map() };
  let file = "";
  for (const line of git(["diff", "-U0", "--no-renames", ...args, "--", "packages"]).split("\n")) {
    if (line.startsWith("--- ")) {
      if (line.startsWith("--- a/")) file = line.slice(6);
      continue;
    }
    if (line.startsWith("+++ ")) {
      if (line.startsWith("+++ b/")) file = line.slice(6);
      continue;
    }
    if (!SOURCE_RE.test(file)) continue;
    const sign = line[0];
    if ((sign !== "+" && sign !== "-") || !JSDOC_LINE_RE.test(line.slice(1))) continue;
    const delta = sign === "+" ? 1 : -1;
    if (delta > 0) jsdoc.added++;
    else jsdoc.deleted++;
    jsdoc.files.set(file, (jsdoc.files.get(file) ?? 0) + delta);
  }

  for (const path of untracked) {
    if (!existsSync(join(root, path))) continue;
    if (DOCS_RE.test(path)) {
      const lines = readFileSync(join(root, path), "utf8").split("\n").length;
      docs.added += lines;
      docs.files.set(path, lines);
    } else if (path.startsWith("packages/") && SOURCE_RE.test(path)) {
      const lines = readFileSync(join(root, path), "utf8")
        .split("\n")
        .filter((line) => JSDOC_LINE_RE.test(line)).length;
      jsdoc.added += lines;
      if (lines > 0) jsdoc.files.set(path, lines);
    }
  }

  const present = [
    ...git(["diff", "--name-only", "--no-renames", "--diff-filter=AM", ...args]).split("\n"),
    ...untracked,
  ];
  const bumps = present
    .filter((path) => CHANGESET_RE.test(path))
    .flatMap((path) => changesetBumps(readFile(path)));

  const readBase = (path) => {
    try {
      return git(["show", `${range.base}:${path}`]);
    } catch {
      return undefined;
    }
  };
  const readTarget = (path) => {
    try {
      return readFile(path);
    } catch {
      return undefined;
    }
  };
  const changesCode = (path) => {
    if (!path.startsWith("packages/")) return false;
    if (/(^|\/)(README|CHANGELOG)\.md$/.test(path)) return false;
    if (!SOURCE_RE.test(path)) return true;
    const before = readBase(path);
    const after = readTarget(path);
    if (before === undefined || after === undefined) return true;
    return printWithoutComments(path, before) !== printWithoutComments(path, after);
  };

  return {
    changesCode: [...new Set(paths)].some(changesCode),
    feature: bumps.includes("minor") || bumps.includes("major"),
    docs,
    jsdoc,
  };
}

/**
 * Returns the reasons a change breaks the docs budget, or an empty list.
 *
 * @param {ReturnType<typeof measureDocsGrowth>} measured
 */
export function docsBudgetIssues(measured) {
  if (!measured.changesCode || measured.feature) return [];
  const issues = [];
  for (const [label, counts] of [
    ["docs/ Markdown", measured.docs],
    ["JSDoc in packages/", measured.jsdoc],
  ]) {
    const growth = counts.added - counts.deleted;
    if (growth <= 0) continue;
    const top = [...counts.files]
      .filter(([, delta]) => delta > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([path, delta]) => `    +${delta} ${path}`);
    issues.push(
      `${label} grows by ${growth} line${growth === 1 ? "" : "s"} (${counts.added} added, ${counts.deleted} deleted):\n${top.join("\n")}`,
    );
  }
  return issues;
}

const HELP = `This change edits packages/ without a minor or major changeset, so it is a bug fix or an
internal change. A fix restores documented behavior and an internal change keeps it, so the
docs may be rewritten but not grow. Do one of these:
  - Remove the added docs. Do not document a fix: the changeset records it.
  - If the change adds behavior users can rely on, it is a feature: give it a minor
    changeset (pnpm changeset; since eve 1.0 features take minor) and title the PR feat:.
  - If the docs were wrong or incomplete apart from this change, fix them in a separate
    docs-only branch and PR titled docs(bugfix):.`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const option = (name) => {
    const index = argv.indexOf(name);
    if (index === -1) return undefined;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value.`);
    return value;
  };
  const known = new Set(["--staged", "--base", "--head"]);
  for (const arg of argv)
    if (arg.startsWith("--") && !known.has(arg))
      throw new Error(
        `Unknown option ${arg}. Usage: check-docs-budget.mjs [--staged] [--base <sha> [--head <sha>]]`,
      );
  const staged = argv.includes("--staged");
  if (staged && hasRef("MERGE_HEAD")) {
    process.stdout.write(
      "[eve:docs-budget] skipped during a merge; CI checks the merged branch.\n",
    );
    process.exit(0);
  }
  const head = option("--head");
  const explicitBase = option("--base");
  if (explicitBase === undefined && staged && !["origin/main", "main"].some(hasRef)) {
    process.stdout.write(
      "[eve:docs-budget] skipped: no main branch to compare with; CI checks the PR.\n",
    );
    process.exit(0);
  }
  const base = explicitBase ?? defaultBase();
  const issues = docsBudgetIssues(measureDocsGrowth({ base, head, staged }));
  if (issues.length === 0) {
    process.stdout.write("[eve:docs-budget] ok\n");
  } else {
    process.stderr.write(`[eve:docs-budget] FAIL\n\n${issues.join("\n\n")}\n\n${HELP}\n`);
    process.exitCode = 1;
  }
}
