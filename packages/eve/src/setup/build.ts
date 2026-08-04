// Build-time generator for the setup island's Web Chat template. Reads the
// `apps/docs/registry/channel/web` source item, applies the declared scaffold transforms,
// and writes `scaffold/create/web-template.ts`. Not part of the shipped package: it is
// excluded from tsconfig.build.json and run on demand via the package scripts
// `generate:web-template` (--write) and `check:web-template` (--check, drift).
//
// Version stamping is NOT handled here: eve's scripts/stamp-version-tokens.mjs
// walks the whole dist and stamps the scaffold's __*_VERSION__ tokens for free.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as ts from "typescript";

const SETUP_ROOT = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SETUP_ROOT, "../../../..");
const SOURCE_ROOT = join(REPO_ROOT, "apps/docs/registry/channel/web");
const REGISTRY_PATH = join(REPO_ROOT, "apps/docs/registry.json");
const OUTPUT_PATH = join(SETUP_ROOT, "scaffold/create/web-template.ts");
const TEMPLATE_SOURCE_ROOT = join(SETUP_ROOT, "scaffold/templates/source");
const TEMPLATE_OUTPUT_PATH = join(SETUP_ROOT, "scaffold/templates.ts");

const SOURCE_ONLY_ROOT_ENTRIES = new Set([
  "README.md",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "vercel.json",
]);
const WEB_CHANNEL_SOURCE_PATH = "agent/channels/eve.ts";

const WEB_TEMPLATE_APP_NAME = "__EVE_INIT_APP_NAME__";

/**
 * Locates the source expression to replace through TypeScript's AST, then
 * preserves all surrounding source text. This makes source-template updates
 * resilient to formatting changes without asking the printer to rewrite the
 * registry-owned file.
 */
function replaceExpression(source: string, node: ts.Expression, replacement: string): string {
  return `${source.slice(0, node.getStart())}${replacement}${source.slice(node.getEnd())}`;
}

function sourceFile(relativePath: string, source: string): ts.SourceFile {
  return ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true);
}

function appNameDeclarationInitializer(file: ts.SourceFile): ts.Expression {
  let initializer: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "AGENT_NAME" &&
      node.initializer !== undefined
    ) {
      if (initializer !== undefined) throw new Error("Expected one AGENT_NAME declaration.");
      initializer = node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (initializer === undefined || !ts.isStringLiteral(initializer)) {
    throw new Error("Expected AGENT_NAME to have a string initializer.");
  }
  return initializer;
}

function metadataTitleInitializer(file: ts.SourceFile): ts.Expression {
  let initializer: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === "title") {
      if (initializer !== undefined) throw new Error("Expected one metadata title property.");
      initializer = node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (initializer === undefined || !ts.isStringLiteral(initializer)) {
    throw new Error("Expected metadata title to have a string initializer.");
  }
  return initializer;
}

function applyDeclaredTransforms(relativePath: string, source: string): string {
  switch (relativePath) {
    case "app/_components/agent-chat.tsx": {
      const file = sourceFile(relativePath, source);
      return replaceExpression(
        source,
        appNameDeclarationInitializer(file),
        JSON.stringify(WEB_TEMPLATE_APP_NAME),
      );
    }
    case "app/layout.tsx": {
      const file = sourceFile(relativePath, source);
      return replaceExpression(
        source,
        metadataTitleInitializer(file),
        JSON.stringify(WEB_TEMPLATE_APP_NAME),
      );
    }
    default:
      return source;
  }
}

function shouldCopySourcePath(relativePath: string): boolean {
  const rootEntry = relativePath.split("/", 1)[0] ?? "";
  if (
    rootEntry.startsWith(".") ||
    SOURCE_ONLY_ROOT_ENTRIES.has(rootEntry) ||
    relativePath.endsWith(".tsbuildinfo")
  ) {
    return false;
  }
  return (
    !relativePath.startsWith("agent/") ||
    relativePath === WEB_CHANNEL_SOURCE_PATH ||
    WEB_CHANNEL_SOURCE_PATH.startsWith(`${relativePath}/`)
  );
}

async function discoverSourceFiles(relativeDirectory = ""): Promise<string[]> {
  const entries = await readdir(join(SOURCE_ROOT, relativeDirectory), { withFileTypes: true });
  const discoveredFiles: string[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (!shouldCopySourcePath(relativePath)) continue;

    if (entry.isDirectory()) {
      discoveredFiles.push(...(await discoverSourceFiles(relativePath)));
    } else if (entry.isFile()) {
      discoveredFiles.push(relativePath);
    }
  }

  return discoveredFiles;
}

function quoteSourceFile(content: string): string {
  return `'${content
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'")
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n")
    .replaceAll("\t", "\\t")}'`;
}

function renderFileEntry(relativePath: string, content: string): string {
  const key = JSON.stringify(relativePath);
  const value = quoteSourceFile(content);
  const inline = `  ${key}: ${value},`;
  return inline.length <= 100 ? inline : `  ${key}:\n    ${value},`;
}

function renderPropertyKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

function renderStringRecord(name: string, record: Record<string, string>): string {
  const values = Object.entries(record).map(
    ([key, value]) => `    ${renderPropertyKey(key)}: ${JSON.stringify(value)},`,
  );
  return [`  ${name}: {`, ...values, "  },"].join("\n");
}

interface PackageTemplate {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

function dependencyRecord(specifiers: unknown, field: string): Record<string, string> {
  if (!Array.isArray(specifiers) || !specifiers.every((value) => typeof value === "string")) {
    throw new Error(`channel/web must define string-array ${field}.`);
  }
  return Object.fromEntries(
    specifiers.map((specifier) => {
      const separator = specifier.lastIndexOf("@");
      if (separator <= 0) throw new Error(`channel/web has invalid dependency ${specifier}.`);
      return [specifier.slice(0, separator), specifier.slice(separator + 1)];
    }),
  );
}

function parsePackageTemplate(source: string): PackageTemplate {
  const parsed = JSON.parse(source) as { items?: Array<Record<string, unknown>> };
  const item = parsed.items?.find((candidate) => candidate.name === "channel/web");
  if (item === undefined) throw new Error("apps/docs/registry.json must define channel/web.");
  return {
    scripts: {
      build: "next build",
      "build:eve": "eve build",
      dev: "next dev",
      "dev:eve": "eve dev",
      start: "next start",
      "start:eve": "eve start",
      typecheck: "tsc --noEmit -p tsconfig.json",
    },
    dependencies: dependencyRecord(item.dependencies, "dependencies"),
    devDependencies: dependencyRecord(item.devDependencies, "devDependencies"),
  };
}

async function discoverTemplateSourceFiles(relativeDirectory = ""): Promise<string[]> {
  const entries = await readdir(join(TEMPLATE_SOURCE_ROOT, relativeDirectory), {
    withFileTypes: true,
  });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await discoverTemplateSourceFiles(relativePath)));
    else if (entry.isFile() && /\.[cm]?tsx?$/.test(entry.name)) files.push(relativePath);
  }
  return files;
}

function templateId(relativePath: string): string {
  return relativePath.replace(/\.[cm]?tsx?$/, "").replaceAll("/", "/");
}

async function renderScaffoldTemplatesModule(): Promise<string> {
  const files = (await discoverTemplateSourceFiles()).filter(
    (relativePath) => !relativePath.endsWith(".d.ts"),
  );
  const entries = await Promise.all(
    files.map(async (relativePath) => {
      const source = await readFile(join(TEMPLATE_SOURCE_ROOT, relativePath), "utf8");
      return renderFileEntry(templateId(relativePath), source);
    }),
  );
  return [
    "// Generated from src/setup/scaffold/templates/source by eve's setup build (src/setup/build.ts).",
    "// Do not edit directly. Run `pnpm --filter eve generate:web-template`.",
    "",
    "export const SCAFFOLD_TEMPLATE_SOURCES = {",
    ...entries,
    "} as const;",
    "",
    "export type ScaffoldTemplateId = keyof typeof SCAFFOLD_TEMPLATE_SOURCES;",
    "",
  ].join("\n");
}

async function renderGeneratedModule(): Promise<string> {
  const sourceFiles = await discoverSourceFiles();
  const entries = await Promise.all(
    sourceFiles.map(async (relativePath) => {
      const source = await readFile(join(SOURCE_ROOT, relativePath), "utf8");
      return renderFileEntry(relativePath, applyDeclaredTransforms(relativePath, source));
    }),
  );
  const packageTemplate = parsePackageTemplate(await readFile(REGISTRY_PATH, "utf8"));

  return [
    "// Generated from apps/docs/registry/channel/web by eve's setup build (src/setup/build.ts).",
    "// Do not edit directly. Edit the app or the declared generator transforms.",
    "",
    "export const WEB_APP_TEMPLATE_FILES = {",
    ...entries,
    "} as const;",
    "",
    "export const WEB_APP_TEMPLATE_PACKAGE_JSON = {",
    renderStringRecord("scripts", packageTemplate.scripts),
    renderStringRecord("dependencies", packageTemplate.dependencies),
    renderStringRecord("devDependencies", packageTemplate.devDependencies),
    "} as const;",
    "",
  ].join("\n");
}

const mode = process.argv[2] ?? "--write";
if (mode !== "--write" && mode !== "--check") {
  throw new Error("Usage: node src/setup/build.ts [--write|--check]");
}

const generated = await renderGeneratedModule();
const generatedTemplates = await renderScaffoldTemplatesModule();
if (mode === "--write") {
  await Promise.all([
    writeFile(OUTPUT_PATH, generated, "utf8"),
    writeFile(TEMPLATE_OUTPUT_PATH, generatedTemplates, "utf8"),
  ]);
} else {
  const [current, currentTemplates] = await Promise.all([
    readFile(OUTPUT_PATH, "utf8"),
    readFile(TEMPLATE_OUTPUT_PATH, "utf8"),
  ]);
  if (current !== generated || currentTemplates !== generatedTemplates) {
    process.stderr.write(
      "Scaffold templates are stale. Run `pnpm --filter eve generate:web-template`.\n",
    );
    process.exitCode = 1;
  }
}
