import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { builtInExtensions, syncExtensions } from "../packages/eve/scripts/sync-extensions.mjs";

const require = createRequire(import.meta.url);
const ts = createRequire(require.resolve("@microsoft/api-extractor/package.json"))("typescript");
const root = fileURLToPath(new URL("../", import.meta.url));
const packagesDir = join(root, "packages");

const SOURCE_RE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

const COMMENT_MESSAGE =
  "Comment outside the public API. Comments may only be JSDoc on declarations a published package entry exports, tool directives (@ts-expect-error, oxlint-disable, /// <reference>, @__PURE__), or license notices (/*! ... */, @license, SPDX-License-Identifier). Delete it. If it states an invariant, enforce it in code instead: a named assert that throws, a type, or a guard rule.";

const DIRECTIVE_RES = [
  /^@ts-(?:expect-error|ignore|nocheck|check)\b/,
  /^(?:oxlint|eslint)-(?:disable|enable)/,
  /^(?:prettier|oxfmt|biome)-ignore/,
  /^[@#]__(?:PURE|NO_SIDE_EFFECTS)__$/,
  /^(?:webpackIgnore|webpackChunkName|@vite-ignore)\b/,
  /^@(?:vitest-environment|jsxImportSource|jsx)\b/,
  /^(?:v8|c8|istanbul) ignore\b/,
  /^@internal$/,
  /^@(?:license|preserve)\b/,
  /^\s*SPDX-License-Identifier:/m,
];

const STRING_LIKE_KINDS = new Set([
  ts.SyntaxKind.JsxText,
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.RegularExpressionLiteral,
]);

/** @param {string} path */
function toRepoPath(path) {
  let absolute = path;
  for (const extension of builtInExtensions) {
    if (absolute.startsWith(extension.target + sep) || absolute.startsWith(`${extension.target}/`))
      absolute = join(extension.source, relative(extension.target, absolute));
  }
  const rel = relative(root, absolute);
  return sep === "/" ? rel : rel.split(sep).join("/");
}

function sourceFiles() {
  const output = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "packages"],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return output
    .split("\0")
    .filter((file) => SOURCE_RE.test(file) && existsSync(join(root, file)))
    .sort();
}

const CODE_RE = /\.(?:[cm]?js|jsx|tsx?)$/;

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function exportTargets(value) {
  if (typeof value === "string") return [value];
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap(exportTargets);
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function declarationTarget(value) {
  if (typeof value === "string") return value.endsWith(".d.ts") ? value : undefined;
  if (typeof value !== "object" || value === null) return undefined;
  if (typeof value.types === "string" && value.types.endsWith(".d.ts")) return value.types;
  for (const nested of Object.values(value)) {
    const found = declarationTarget(nested);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * @param {string} packageDir
 * @param {string} key
 * @param {unknown} value
 * @returns {string[] | undefined}
 */
function entrySources(packageDir, key, value) {
  const source = typeof value === "object" && value !== null ? value["eve-source"] : undefined;
  if (typeof source === "string" && /\.tsx?$/.test(source) && !source.startsWith("./dist/"))
    return [join(packageDir, source)];
  const types = declarationTarget(value);
  if (types === undefined)
    return exportTargets(value).some((target) => CODE_RE.test(target)) ? undefined : [];
  const rest = types.replace(/^\.\/dist\//, "").replace(/\.d\.ts$/, "");
  for (const candidate of [`${rest}.ts`, `${rest}.tsx`, `${rest}/index.ts`, `${rest}.d.ts`]) {
    if (existsSync(join(packageDir, candidate))) return [join(packageDir, candidate)];
  }
  const extensionDir = join(packageDir, "extension");
  if (!existsSync(join(extensionDir, "extension.ts"))) return undefined;
  if (key === ".") return [join(extensionDir, "extension.ts")];
  if (key === "./tools")
    return readdirSync(join(extensionDir, "tools"))
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => join(extensionDir, "tools", name));
  const lib = join(extensionDir, "lib", `${basename(rest)}.ts`);
  return existsSync(lib) ? [lib] : undefined;
}

function publicEntries() {
  const entries = [];
  const issues = [];
  for (const name of readdirSync(packagesDir).sort()) {
    const packageDir = join(packagesDir, name);
    const manifestPath = join(packageDir, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.private || manifest.exports === undefined) continue;
    const exportsMap =
      typeof manifest.exports === "string" ? { ".": manifest.exports } : manifest.exports;
    for (const [key, value] of Object.entries(exportsMap)) {
      if (key === "./package.json" || key === "./internal" || key.startsWith("./internal/"))
        continue;
      const sources = entrySources(packageDir, key, value);
      if (sources === undefined) {
        issues.push({
          rule: 66,
          file: toRepoPath(manifestPath),
          message: `Cannot map export "${key}" of ${manifest.name} to a source file, so its public declarations are unknown. Extend entrySources() in scripts/comment-policy.mjs.`,
        });
        continue;
      }
      for (const source of sources)
        entries.push({ entry: `${manifest.name}${key.slice(1)}`, source });
    }
  }
  return { entries, issues };
}

/** @param {string} text */
function commentBody(text) {
  if (text.startsWith("//")) return text.slice(2).trim();
  return text
    .replace(/^\/\*\*?/, "")
    .replace(/\*\/$/, "")
    .replace(/^\s*\*/gm, "")
    .trim();
}

/** @param {string} text */
export function isDirective(text) {
  if (text.startsWith("/// <") || text.startsWith("/*!")) return true;
  const body = commentBody(text);
  return DIRECTIVE_RES.some((re) => re.test(body));
}

/** @param {string} text */
function isJsDoc(text) {
  return text.startsWith("/**") && !text.startsWith("/**/");
}

/** @param {string} text */
function hasDocContent(text) {
  const body = commentBody(text);
  return body.length > 0 && body !== "@internal";
}

/**
 * @param {import("typescript").SourceFile} file
 * @returns {{ pos: number; end: number; text: string }[]}
 */
export function collectComments(file) {
  const text = file.text;
  const ranges = new Map();
  const literals = [];
  const add = (found) => {
    for (const range of found ?? []) if (!ranges.has(range.pos)) ranges.set(range.pos, range);
  };
  const visit = (node) => {
    if (STRING_LIKE_KINDS.has(node.kind)) literals.push([node.getStart(file), node.end]);
    add(ts.getLeadingCommentRanges(text, node.pos));
    add(ts.getTrailingCommentRanges(text, node.end));
    for (const child of node.getChildren(file)) visit(child);
  };
  visit(file);
  return [...ranges.values()]
    .filter((range) => !literals.some(([start, end]) => range.pos >= start && range.pos < end))
    .sort((a, b) => a.pos - b.pos)
    .map((range) => ({ pos: range.pos, end: range.end, text: text.slice(range.pos, range.end) }));
}

/** @param {import("typescript").Node} node */
function docHost(node) {
  if (ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent))
    return node.parent.parent;
  return node;
}

/** @param {import("typescript").Node} node */
function isPrivateMember(node) {
  if (node.name !== undefined && ts.isPrivateIdentifier(node.name)) return true;
  return (ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : []).some(
    (modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword,
  );
}

/**
 * @param {import("typescript").SourceFile} file
 * @param {import("typescript").Node} node
 */
function jsDocBefore(file, node) {
  return (ts.getLeadingCommentRanges(file.text, node.pos) ?? []).filter((range) =>
    isJsDoc(file.text.slice(range.pos, range.end)),
  );
}

/**
 * Collects the positions of every JSDoc comment that documents part of a
 * published declaration, and the exports that have none.
 */
function publicDocs() {
  const { entries, issues } = publicEntries();
  const program = ts.createProgram(
    entries.map((item) => item.source),
    {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.Preserve,
      customConditions: ["eve-source"],
      allowImportingTsExtensions: true,
      resolveJsonModule: true,
      noEmit: true,
      skipLibCheck: true,
    },
  );
  const checker = program.getTypeChecker();
  /** @type {Map<string, Set<number>>} */
  const allowed = new Map();
  /** @type {Map<string, { file: string; line: number; name: string; entry: string }>} */
  const undocumented = new Map();
  const visited = new Set();
  const pending = [];

  const hostsOf = (symbol) => {
    const target =
      symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(symbol)
        : symbol;
    return (target?.declarations ?? [])
      .filter((node) => !ts.isSourceFile(node) && !ts.isModuleDeclaration(node))
      .map(docHost)
      .filter((node) =>
        /^packages\/[^/]+\/(?!node_modules\/|\.generated\/|dist\/)/.test(
          toRepoPath(node.getSourceFile().fileName),
        ),
      );
  };

  const enqueue = (symbol) => {
    for (const host of hostsOf(symbol)) {
      if (visited.has(host)) continue;
      visited.add(host);
      pending.push(host);
    }
  };

  const enqueueType = (type) => {
    if (type === undefined) return;
    enqueue(type.aliasSymbol);
    enqueue(type.getSymbol());
  };

  const allow = (host) => {
    const file = host.getSourceFile();
    const path = toRepoPath(file.fileName);
    let positions = allowed.get(path);
    if (positions === undefined) allowed.set(path, (positions = new Set()));
    const walk = (current) => {
      if (isPrivateMember(current)) return;
      for (const range of jsDocBefore(file, current)) positions.add(range.pos);
      if (ts.isIdentifier(current)) enqueue(checker.getSymbolAtLocation(current));
      if (ts.isVariableDeclaration(current) && current.type === undefined)
        enqueueType(checker.getTypeAtLocation(current));
      if (ts.isFunctionLike(current) && current.type === undefined) {
        const signature = checker.getSignatureFromDeclaration(current);
        if (signature !== undefined) enqueueType(checker.getReturnTypeOfSignature(signature));
      }
      ts.forEachChild(current, (child) => {
        if (ts.isFunctionLike(current) && child === current.body) return;
        walk(child);
      });
    };
    walk(host);
  };

  for (const { entry, source } of entries) {
    const sourceFile = program.getSourceFile(source);
    const moduleSymbol = sourceFile && checker.getSymbolAtLocation(sourceFile);
    if (moduleSymbol === undefined) {
      issues.push({
        rule: 66,
        file: toRepoPath(source),
        message: `Public entry ${entry} does not resolve to a module, so its public declarations are unknown.`,
      });
      continue;
    }
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const symbol =
        exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      const hosts = hostsOf(symbol);
      if (hosts.length === 0) continue;
      enqueue(symbol);
      const documented = hosts.some((host) => {
        const file = host.getSourceFile();
        return jsDocBefore(file, host).some((range) =>
          hasDocContent(file.text.slice(range.pos, range.end)),
        );
      });
      if (documented) continue;
      const host = hosts[0];
      const file = host.getSourceFile();
      const path = toRepoPath(file.fileName);
      const key = `${path}#${symbol.name === "default" ? exported.name : symbol.name}`;
      if (!undocumented.has(key))
        undocumented.set(key, {
          file: path,
          line: file.getLineAndCharacterOfPosition(host.getStart(file)).line + 1,
          name: exported.name,
          entry,
        });
    }
  }
  while (pending.length > 0) allow(pending.pop());
  return { allowed, undocumented, issues };
}

/** @param {string} path */
function scriptKind(path) {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(?:js|mjs|cjs)$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * Computes every disallowed comment and undocumented public export in the
 * workspace packages.
 */
export async function collectCommentState() {
  await syncExtensions();
  const { allowed, undocumented, issues } = publicDocs();
  /** @type {Map<string, { pos: number; end: number; text: string; line: number }[]>} */
  const comments = new Map();
  for (const path of sourceFiles()) {
    const text = await readFile(join(root, path), "utf8");
    const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, scriptKind(path));
    const positions = allowed.get(path);
    const found = [];
    for (const comment of collectComments(file)) {
      if (isDirective(comment.text)) continue;
      if (isJsDoc(comment.text) && positions?.has(comment.pos)) continue;
      found.push({
        ...comment,
        line: file.getLineAndCharacterOfPosition(comment.pos).line + 1,
      });
    }
    if (found.length > 0) comments.set(path, found);
  }
  return { comments, undocumented, issues };
}

/** Returns every comment outside the public API (rule 66) and every undocumented published export (rule 67). */
export async function checkComments() {
  const { comments, undocumented, issues } = await collectCommentState();
  for (const [file, found] of comments)
    for (const comment of found)
      issues.push({ rule: 66, file, line: comment.line, message: COMMENT_MESSAGE });
  for (const item of undocumented.values())
    issues.push({
      rule: 67,
      file: item.file,
      line: item.line,
      message: `${item.name} is exported from ${item.entry} without JSDoc. Every published export needs a doc comment that tells users what it is for.`,
    });
  return issues;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length > 2) throw new Error("Usage: node scripts/comment-policy.mjs");
  const issues = await checkComments();
  for (const issue of issues)
    process.stderr.write(
      `rule ${issue.rule} ${issue.file}${issue.line ? `:${issue.line}` : ""}: ${issue.message}\n`,
    );
  if (issues.length > 0) process.exitCode = 1;
  else
    process.stdout.write(
      "[eve:comment-policy] ok — comments are public API docs and every published export has JSDoc.\n",
    );
}
