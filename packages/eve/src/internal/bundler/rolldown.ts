import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative } from "node:path";

import type {
  BuildOptions,
  LogLevel,
  LogOrStringHandler,
  OutputAsset,
  OutputChunk,
  Plugin,
  RolldownLog,
  RolldownOutput,
} from "rolldown";

import { createPseudoPackagePlugin } from "#internal/bundler/pseudo-packages.js";
import { onVendoredDependencyLog } from "#internal/bundler/vendored-dependency-log.js";

export type RolldownOutputChunk = OutputChunk;
export type RolldownOutputAsset = OutputAsset;

type RolldownParserLanguage = "js" | "jsx" | "ts" | "tsx";

let rolldownPromise: Promise<typeof import("rolldown")> | undefined;
let rolldownParseAstPromise: Promise<typeof import("rolldown/parseAst")> | undefined;

function loadRolldown(): Promise<typeof import("rolldown")> {
  rolldownPromise ??= import("rolldown");
  return rolldownPromise;
}

export function resolveRolldownPackageDir(): string {
  return dirname(createRequire(import.meta.url).resolve("rolldown/package.json"));
}

function loadRolldownParseAst(): Promise<typeof import("rolldown/parseAst")> {
  rolldownParseAstPromise ??= import("rolldown/parseAst");
  return rolldownParseAstPromise;
}

export function inferRolldownParserLanguage(filename: string): RolldownParserLanguage {
  if (filename.endsWith(".tsx")) return "tsx";
  if (filename.endsWith(".jsx")) return "jsx";
  if (/\.[cm]?ts$/.test(filename)) return "ts";
  return "js";
}

export async function parseWithRolldownAst(filename: string, sourceText: string): Promise<unknown> {
  const { parseAst } = await loadRolldownParseAst();
  return parseAst(
    sourceText,
    {
      astType: "ts",
      lang: inferRolldownParserLanguage(filename),
      range: true,
      sourceType: "module",
    },
    filename,
  );
}

export async function buildWithRolldown(options: BuildOptions): Promise<RolldownOutput> {
  assertCustomRolldownConditionNames(options);
  const { build } = await loadRolldown();
  return await build({
    checks: { bundlerTimings: false },
    onLog: onRolldownBuildLog,
    ...options,
    plugins: [createPseudoPackagePlugin(), options.plugins],
    experimental: { ...options.experimental, attachDebugInfo: "none" },
  });
}

function onRolldownBuildLog(
  level: LogLevel,
  log: RolldownLog,
  defaultHandler: LogOrStringHandler,
): void {
  if (level === "warn" && log.code === "UNRESOLVED_IMPORT") {
    defaultHandler(level, log);
    return;
  }
  onVendoredDependencyLog(level, log, defaultHandler);
}

export const ROLLDOWN_STANDARD_CONDITION_NAMES: ReadonlySet<string> = new Set([
  "browser",
  "default",
  "import",
  "node",
  "require",
]);

function assertCustomRolldownConditionNames(options: BuildOptions): void {
  for (const conditionName of options.resolve?.conditionNames ?? []) {
    if (ROLLDOWN_STANDARD_CONDITION_NAMES.has(conditionName)) {
      throw new Error(
        `Rolldown resolves the standard condition ${JSON.stringify(conditionName)} per import edge; conditionNames may contain only eve-specific additions.`,
      );
    }
  }
}

const MAX_REPORTED_CHUNKS = 10;
const MAX_REPORTED_MODULES_PER_CHUNK = 8;
const MAX_REPORTED_NON_ENTRY_MODULES = 10;
const MAX_REPORTED_DIRECT_IMPORTERS = 5;
const MAX_BFS_VISITED_MODULES = 2_000;
const MAX_BFS_DEPTH = 32;

const SINGLE_CHUNK_HINT_PREFIX =
  "Hint: eve bundles authored code into one file with codeSplitting: false, so extra chunks usually come from a dynamic import() edge, a plugin emitting an extra chunk, or a bundler chunk-splitting edge case.";

type ImportEdgeKind = "static" | "dynamic";

interface RecordedModuleInfo {
  readonly importedIds: readonly string[];
  readonly dynamicallyImportedIds: readonly string[];
  readonly importers: readonly string[];
  readonly dynamicImporters: readonly string[];
  readonly isEntry: boolean;
}

interface ImportEdge {
  readonly from: string;
  readonly kind: ImportEdgeKind;
}

export async function buildSingleRolldownChunk(
  description: string,
  options: BuildOptions,
): Promise<RolldownOutputChunk> {
  const moduleGraph = new Map<string, RecordedModuleInfo>();
  const cwd = options.cwd ?? process.cwd();
  const result = await buildWithRolldown({
    ...options,
    plugins: [options.plugins, createSingleChunkGraphPlugin(moduleGraph)],
    write: false,
    output: { ...options.output, codeSplitting: false },
  });
  return getSingleRolldownChunk(result, description, cwd, moduleGraph);
}

function createSingleChunkGraphPlugin(moduleGraph: Map<string, RecordedModuleInfo>): Plugin {
  return {
    name: "eve-single-chunk-module-graph",
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        let chunkCount = 0;
        for (const item of Object.values(bundle)) {
          if (item.type === "chunk" && ++chunkCount > 1) break;
        }
        if (chunkCount <= 1) return;

        for (const id of this.getModuleIds()) {
          const info = this.getModuleInfo(id);
          if (info === null) continue;
          moduleGraph.set(id, {
            importedIds: [...info.importedIds],
            dynamicallyImportedIds: [...info.dynamicallyImportedIds],
            importers: [...info.importers],
            dynamicImporters: [...info.dynamicImporters],
            isEntry: info.isEntry,
          });
        }
      },
    },
  };
}

function getSingleRolldownChunk(
  output: RolldownOutput,
  description: string,
  cwd: string,
  moduleGraph: ReadonlyMap<string, RecordedModuleInfo>,
): RolldownOutputChunk {
  const chunks = output.output.filter((item) => item.type === "chunk");
  const chunk = chunks[0];

  if (chunk === undefined) {
    throw new Error(`Expected one bundled ${description}, but Rolldown emitted no chunks.`);
  }

  if (chunks.length !== 1) {
    throw new Error(formatMultipleRolldownChunksError(description, chunks, cwd, moduleGraph));
  }

  return chunk;
}

function resolveRealCwd(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return cwd;
  }
}

function formatModuleId(id: string, cwd: string, realCwd: string): string {
  if (id.includes("\0")) {
    return id.replaceAll("\0", "\\0");
  }
  if (!isAbsolute(id)) {
    return id;
  }
  const fromCwd = relative(cwd, id);
  const fromRealCwd = realCwd === cwd ? fromCwd : relative(realCwd, id);
  const best = fromRealCwd.length < fromCwd.length ? fromRealCwd : fromCwd;
  if (best.length === 0) {
    return ".";
  }
  return best.replaceAll("\\", "/");
}

function formatChunkSummaryLine(chunk: RolldownOutputChunk, cwd: string, realCwd: string): string {
  const role = chunk.isEntry ? "entry" : "non-entry";
  let modulesSummary: string;
  if (chunk.moduleIds.length === 0) {
    modulesSummary =
      chunk.facadeModuleId === null
        ? "(no modules)"
        : `(no inlined modules; facade for ${formatModuleId(chunk.facadeModuleId, cwd, realCwd)})`;
  } else {
    const visible = chunk.moduleIds
      .slice(0, MAX_REPORTED_MODULES_PER_CHUNK)
      .map((id) => formatModuleId(id, cwd, realCwd));
    const remaining = chunk.moduleIds.length - visible.length;
    modulesSummary =
      remaining > 0 ? `${visible.join(", ")}, +${remaining} more` : visible.join(", ");
  }
  return `  - ${chunk.fileName} (${role}): ${modulesSummary}`;
}

function collectEntryModuleIds(
  chunks: readonly RolldownOutputChunk[],
  nonEntryModuleIds: ReadonlySet<string>,
  moduleGraph: ReadonlyMap<string, RecordedModuleInfo>,
): string[] {
  const candidates = new Set<string>();
  for (const chunk of chunks) {
    if (chunk.isEntry && chunk.facadeModuleId !== null) {
      candidates.add(chunk.facadeModuleId);
    }
  }
  for (const [moduleId, info] of moduleGraph) {
    if (info.isEntry) {
      candidates.add(moduleId);
    }
  }

  const primaryEntries = [...candidates].filter((moduleId) => !nonEntryModuleIds.has(moduleId));
  return primaryEntries.length > 0 ? primaryEntries : [...candidates];
}

function findShortestEntryParents(
  entryIds: readonly string[],
  moduleGraph: ReadonlyMap<string, RecordedModuleInfo>,
): Map<string, ImportEdge> {
  const parents = new Map<string, ImportEdge>();
  const visited = new Set<string>();
  const queue: Array<{ readonly id: string; readonly depth: number }> = [];

  for (const entryId of entryIds) {
    if (visited.has(entryId) || visited.size >= MAX_BFS_VISITED_MODULES) continue;
    visited.add(entryId);
    queue.push({ id: entryId, depth: 0 });
  }

  const enqueue = (from: string, targetId: string, kind: ImportEdgeKind, depth: number) => {
    if (visited.has(targetId) || visited.size >= MAX_BFS_VISITED_MODULES) return;
    visited.add(targetId);
    parents.set(targetId, { from, kind });
    queue.push({ id: targetId, depth });
  };

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (current === undefined || current.depth >= MAX_BFS_DEPTH) continue;
    const info = moduleGraph.get(current.id);
    if (info === undefined) continue;
    const nextDepth = current.depth + 1;

    for (const targetId of info.importedIds) {
      enqueue(current.id, targetId, "static", nextDepth);
    }
    for (const targetId of info.dynamicallyImportedIds) {
      enqueue(current.id, targetId, "dynamic", nextDepth);
    }
  }

  return parents;
}

function directImporterEdges(info: RecordedModuleInfo | undefined): ImportEdge[] {
  if (info === undefined) return [];
  const edges: ImportEdge[] = [];
  for (const from of new Set(info.importers)) {
    edges.push({ from, kind: "static" });
  }
  for (const from of new Set(info.dynamicImporters)) {
    edges.push({ from, kind: "dynamic" });
  }
  return edges;
}

function formatEdgeArrow(kind: ImportEdgeKind): string {
  return kind === "dynamic" ? " --import()--> " : " -> ";
}

function formatImporterChain(
  targetId: string,
  edge: ImportEdge,
  parents: ReadonlyMap<string, ImportEdge>,
  cwd: string,
  realCwd: string,
): string {
  const reversed: string[] = [
    formatModuleId(targetId, cwd, realCwd),
    formatEdgeArrow(edge.kind),
    formatModuleId(edge.from, cwd, realCwd),
  ];
  const seen = new Set<string>([edge.from]);
  let current = edge.from;

  for (let hops = 0; hops < MAX_BFS_DEPTH; hops += 1) {
    const parent = parents.get(current);
    if (parent === undefined || seen.has(parent.from)) break;
    seen.add(parent.from);
    reversed.push(formatEdgeArrow(parent.kind), formatModuleId(parent.from, cwd, realCwd));
    current = parent.from;
  }

  reversed.reverse();
  return reversed.join("");
}

function formatMultipleRolldownChunksError(
  description: string,
  chunks: readonly RolldownOutputChunk[],
  cwd: string,
  moduleGraph: ReadonlyMap<string, RecordedModuleInfo>,
): string {
  const realCwd = resolveRealCwd(cwd);
  const lines: string[] = [
    `Expected one bundled ${description}, but Rolldown emitted ${chunks.length} chunks:`,
  ];

  for (const chunk of chunks.slice(0, MAX_REPORTED_CHUNKS)) {
    lines.push(formatChunkSummaryLine(chunk, cwd, realCwd));
  }
  if (chunks.length > MAX_REPORTED_CHUNKS) {
    lines.push(`  - ... +${chunks.length - MAX_REPORTED_CHUNKS} more chunks`);
  }

  const nonEntryModuleIds = new Set<string>();
  const reportedNonEntryCandidates: string[] = [];
  for (const chunk of chunks) {
    if (chunk.isEntry) continue;
    for (const moduleId of chunk.moduleIds) {
      if (nonEntryModuleIds.has(moduleId)) continue;
      nonEntryModuleIds.add(moduleId);
      if (moduleId.startsWith("\0rolldown/") && !moduleGraph.has(moduleId)) continue;
      reportedNonEntryCandidates.push(moduleId);
    }
  }

  if (reportedNonEntryCandidates.length > 0) {
    const entryIds = collectEntryModuleIds(chunks, nonEntryModuleIds, moduleGraph);
    const entryParents = findShortestEntryParents(entryIds, moduleGraph);

    lines.push("Non-entry chunk module importers:");
    for (const moduleId of reportedNonEntryCandidates.slice(0, MAX_REPORTED_NON_ENTRY_MODULES)) {
      lines.push(`  - ${formatModuleId(moduleId, cwd, realCwd)}`);
      const edges = directImporterEdges(moduleGraph.get(moduleId));
      if (edges.length === 0) {
        lines.push("    (no recorded importers)");
        continue;
      }
      for (const edge of edges.slice(0, MAX_REPORTED_DIRECT_IMPORTERS)) {
        lines.push(`    ${formatImporterChain(moduleId, edge, entryParents, cwd, realCwd)}`);
      }
      if (edges.length > MAX_REPORTED_DIRECT_IMPORTERS) {
        lines.push(`    ... +${edges.length - MAX_REPORTED_DIRECT_IMPORTERS} more importers`);
      }
    }
    if (reportedNonEntryCandidates.length > MAX_REPORTED_NON_ENTRY_MODULES) {
      lines.push(
        `  - ... +${reportedNonEntryCandidates.length - MAX_REPORTED_NON_ENTRY_MODULES} more non-entry modules`,
      );
    }
    lines.push(
      `${SINGLE_CHUNK_HINT_PREFIX} Check the non-entry modules and import() edges listed above.`,
    );
  } else {
    lines.push(`${SINGLE_CHUNK_HINT_PREFIX} Check the extra entry chunks listed above.`);
  }

  return lines.join("\n");
}
