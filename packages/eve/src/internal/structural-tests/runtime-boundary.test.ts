import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it } from "vitest";

const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const DISALLOWED_ENTRYPOINT_PREFIXES = ["channel/", "harness/"];
const WORKFLOW_PRIMITIVE_SPECIFIERS = new Set([
  "#compiled/@workflow/core/index.js",
  "#compiled/@workflow/core/runtime.js",
]);
// Existing reachability debt through ContextKey serialization. This set should only shrink.
const WORKFLOW_REACHABILITY_ALLOWLIST = new Set([
  "harness/attachment-staging.ts",
  "harness/tool-loop.ts",
]);
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage"]);
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"] as const;

interface SourceModule {
  readonly file: string;
  readonly imports: readonly string[];
  readonly importsWorkflowPrimitive: boolean;
}

describe("runtime boundary structure", () => {
  it("keeps channel and harness code transitively workflow-agnostic", async () => {
    const modules = await buildSourceGraph();
    const { staleAllowlist, violations } = findWorkflowReachabilityViolations(modules);

    if (violations.length > 0 || staleAllowlist.length > 0) {
      throw new Error(formatReachabilityFailure({ staleAllowlist, violations }));
    }
  });
});

async function buildSourceGraph(): Promise<Map<string, SourceModule>> {
  const sourceFiles = await listSourceFiles(SOURCE_ROOT);
  const knownFiles = new Set(sourceFiles.map((file) => toPosix(relative(SOURCE_ROOT, file))));
  const modules = new Map<string, SourceModule>();

  for (const absPath of sourceFiles) {
    const file = toPosix(relative(SOURCE_ROOT, absPath));
    const content = await readFile(absPath, "utf8");
    const specifiers = parseValueImportSpecifiers(content);
    const imports: string[] = [];
    let importsWorkflowPrimitive = false;

    for (const specifier of specifiers) {
      if (WORKFLOW_PRIMITIVE_SPECIFIERS.has(specifier)) {
        importsWorkflowPrimitive = true;
        continue;
      }

      const resolved = resolveSourceImport({ importer: absPath, knownFiles, specifier });
      if (resolved !== undefined) {
        imports.push(resolved);
      }
    }

    modules.set(file, { file, imports, importsWorkflowPrimitive });
  }

  return modules;
}

async function listSourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const entries = (await readdir(root, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;

    const absPath = resolve(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(absPath)));
      continue;
    }

    if (entry.isFile() && isProductionSourceFile(entry.name)) {
      files.push(absPath);
    }
  }

  return files;
}

function isProductionSourceFile(fileName: string): boolean {
  return (
    SOURCE_EXTENSIONS.some((extension) => fileName.endsWith(extension)) &&
    !fileName.endsWith(".d.ts") &&
    !/\.(test|integration|scenario)\.(cts|mts|ts|tsx)$/.test(fileName)
  );
}

function parseValueImportSpecifiers(content: string): string[] {
  const specifiers: string[] = [];

  for (const match of content.matchAll(
    /\bimport\s+(?!type\b)(?:[^"']*?\sfrom\s*)?["']([^"']+)["']/g,
  )) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }

  for (const match of content.matchAll(/\bexport\s+(?!type\b)[^"']*?\sfrom\s*["']([^"']+)["']/g)) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }

  return specifiers;
}

function resolveSourceImport({
  importer,
  knownFiles,
  specifier,
}: {
  importer: string;
  knownFiles: Set<string>;
  specifier: string;
}): string | undefined {
  if (specifier.startsWith("#")) {
    return resolveKnownSourcePath({ knownFiles, sourcePath: specifier.slice(1) });
  }

  if (!specifier.startsWith(".")) return undefined;

  const importRoot = resolve(dirname(importer), specifier);
  return resolveKnownSourcePath({
    knownFiles,
    sourcePath: toPosix(relative(SOURCE_ROOT, importRoot)),
  });
}

function resolveKnownSourcePath({
  knownFiles,
  sourcePath,
}: {
  knownFiles: Set<string>;
  sourcePath: string;
}): string | undefined {
  const importRoot = resolve(SOURCE_ROOT, sourcePath);
  for (const candidate of moduleResolutionCandidates(importRoot)) {
    const relPath = toPosix(relative(SOURCE_ROOT, candidate));
    if (knownFiles.has(relPath)) return relPath;
  }

  return undefined;
}

function moduleResolutionCandidates(importRoot: string): string[] {
  const withoutJsExtension = importRoot.replace(/\.(c|m)?js$/, "");
  const candidates: string[] = [];

  for (const extension of SOURCE_EXTENSIONS) {
    candidates.push(`${withoutJsExtension}${extension}`);
  }

  for (const extension of SOURCE_EXTENSIONS) {
    candidates.push(resolve(withoutJsExtension, `index${extension}`));
  }

  return candidates;
}

function findWorkflowReachabilityViolations(modules: Map<string, SourceModule>): {
  staleAllowlist: string[];
  violations: string[][];
} {
  const violations: string[][] = [];
  const observedAllowlist = new Set<string>();

  for (const file of modules.keys()) {
    if (!DISALLOWED_ENTRYPOINT_PREFIXES.some((prefix) => file.startsWith(prefix))) continue;

    const path = findPathToWorkflowPrimitive({ file, modules, seen: new Set() });
    if (path !== undefined) {
      if (WORKFLOW_REACHABILITY_ALLOWLIST.has(file)) {
        observedAllowlist.add(file);
      } else {
        violations.push(path);
      }
    }
  }

  const staleAllowlist = [...WORKFLOW_REACHABILITY_ALLOWLIST].filter(
    (file) => !observedAllowlist.has(file),
  );

  return { staleAllowlist, violations };
}

function findPathToWorkflowPrimitive({
  file,
  modules,
  seen,
}: {
  file: string;
  modules: Map<string, SourceModule>;
  seen: Set<string>;
}): string[] | undefined {
  if (seen.has(file)) return undefined;
  seen.add(file);

  const module = modules.get(file);
  if (module === undefined) return undefined;

  if (module.importsWorkflowPrimitive) {
    return [file];
  }

  for (const importedFile of module.imports) {
    const path = findPathToWorkflowPrimitive({ file: importedFile, modules, seen });
    if (path !== undefined) {
      return [file, ...path];
    }
  }

  return undefined;
}

function formatReachabilityFailure({
  staleAllowlist,
  violations,
}: {
  staleAllowlist: string[];
  violations: string[][];
}): string {
  const sections = [
    "Channel and harness production code must stay workflow-agnostic.",
    "A channel or harness file can transitively reach vendored Workflow primitives.",
    "Move the workflow primitive call behind a runtime/execution-owned helper, then have the channel or harness depend on that eve-owned boundary instead.",
  ];

  if (violations.length > 0) {
    sections.push(
      "",
      "New transitive workflow reachability paths:",
      ...violations.map((path) => `  - ${path.join(" -> ")}`),
    );
  }

  if (staleAllowlist.length > 0) {
    sections.push(
      "",
      "Remove stale allowlist entries whose workflow reachability has been fixed:",
      ...staleAllowlist.map((file) => `  - ${file}`),
    );
  }

  return sections.join("\n");
}

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}
