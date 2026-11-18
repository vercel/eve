import { createHash } from "node:crypto";
import { readdir, readFile, rename, stat, writeFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { CompileAgentResult } from "#compiler/compile-agent.js";
import type { CompilerArtifactPaths } from "#compiler/artifacts.js";
import type { CompileMetadata } from "#compiler/artifact-contract.js";
import type { CompiledAgentManifest } from "#compiler/manifest.js";
import type { CompilerDiagnostic } from "#compiler/diagnostics.js";
import type { ResolvedDiscoveryProject } from "#discover/project.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { mapWithConcurrency } from "#shared/map-with-concurrency.js";

const INSPECT_CACHE_KIND = "eve-inspect-cache";
const INSPECT_CACHE_VERSION = 1;
const RECENT_EDIT_WINDOW_MS = 2_000;
const SOURCE_READ_CONCURRENCY = 64;
const SKIPPED_DIRECTORY_NAMES = new Set([
  ".cache",
  ".eve",
  ".git",
  ".next",
  ".nuxt",
  ".output",
  ".svelte-kit",
  ".turbo",
  ".vercel",
  "node_modules",
]);
const PROJECT_FILE_NAMES = [
  "bun.lock",
  "bun.lockb",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "yarn.lock",
];
const TRACKED_ENV_PREFIXES = ["EVE_", "VERCEL"];
const TRACKED_ENV_NAMES = new Set(["NODE_ENV"]);
const ENV_REFERENCE = /\bprocess\.env\b/g;
const LITERAL_ENV_REFERENCE =
  /\bprocess\.env(?:\.([A-Za-z_$][\w$]*)|\[\s*(["'])([^"'\\]+)\2\s*\])/g;
const ENV_MODULE_IMPORT =
  /\bfrom\s*["'](?:node:)?process["']|\brequire\(\s*["'](?:node:)?process["']\s*\)/;
const MODEL_METADATA_UNAVAILABLE = "compile/model-metadata-unavailable";

type FileStamp = string | null;

interface InspectCacheRecord {
  readonly kind: typeof INSPECT_CACHE_KIND;
  readonly version: typeof INSPECT_CACHE_VERSION;
  readonly generator: string;
  readonly startPath: string;
  readonly project: ResolvedDiscoveryProject;
  readonly paths: CompilerArtifactPaths;
  readonly tree: Readonly<Record<string, string>>;
  readonly files: Readonly<Record<string, FileStamp>>;
  readonly artifacts: Readonly<Record<string, FileStamp>>;
  readonly envNames: readonly string[];
  readonly env: Readonly<Record<string, string | null>>;
}

interface CompilerDiagnosticsArtifact {
  readonly diagnostics: CompilerDiagnostic[];
}

export function resolveInspectCachePath(appRoot: string): string {
  return join(appRoot, ".eve", "cache", "inspect.json");
}

export async function readCachedCompile(startPath: string): Promise<CompileAgentResult | null> {
  const record = await readRecord(startPath);
  if (record === null || record.startPath !== startPath) return null;
  if (record.generator !== (await resolveGenerator())) return null;
  if (!sameStamps(record.artifacts, await stampFiles(Object.keys(record.artifacts)))) return null;
  if (!sameStamps(record.files, await stampFiles(Object.keys(record.files)))) return null;
  if (!sameStamps(record.env, hashEnv(trackedEnvNames(record.envNames, record.env)))) return null;
  const tree = await stampTree(record.project.agentRoot);
  if (tree === null || !sameStamps(record.tree, tree)) return null;

  try {
    const [manifest, metadata, diagnostics] = await Promise.all([
      readJson<CompiledAgentManifest>(record.paths.compiledManifestPath),
      readJson<CompileMetadata>(record.paths.compileMetadataPath),
      readJson<CompilerDiagnosticsArtifact>(record.paths.diagnosticsPath),
    ]);
    return {
      diagnostics: diagnostics.diagnostics,
      manifest,
      metadata,
      paths: record.paths,
      project: record.project,
    };
  } catch {
    return null;
  }
}

export async function writeCachedCompile(input: {
  readonly startPath: string;
  readonly result: CompileAgentResult;
  readonly moduleIds: ReadonlySet<string>;
  readonly startedAtMs: number;
}): Promise<void> {
  const { project, paths } = input.result;
  if (input.result.metadata.status !== "ready") return;
  if (
    input.result.diagnostics.some((diagnostic) => diagnostic.code === MODEL_METADATA_UNAVAILABLE)
  ) {
    return;
  }

  const sourcePaths = [...input.moduleIds].flatMap((moduleId) => {
    const path = moduleId.split("?")[0]!;
    return isAbsolute(path) && !path.split(sep).includes("node_modules") ? [path] : [];
  });
  const envNames = await collectEnvNames(sourcePaths);
  if (envNames === null) return;

  const tree = await stampTree(project.agentRoot);
  const sources = await stampFiles(
    sourcePaths.filter((path) => !isInside(path, project.agentRoot)),
  );
  const files = { ...(await stampFiles(projectFilePaths(project.appRoot))), ...sources };
  const artifacts = await stampFiles([
    paths.compiledManifestPath,
    paths.compileMetadataPath,
    paths.diagnosticsPath,
    paths.discoveryManifestPath,
    paths.moduleMapPath,
  ]);
  if (tree === null || Object.values(sources).includes(null)) return;
  if (Object.values(artifacts).includes(null)) return;
  const editedAfterStart = [...Object.values(tree), ...Object.values(files)].some(
    (stamp) => stamp !== null && modifiedAtMs(stamp) >= input.startedAtMs - RECENT_EDIT_WINDOW_MS,
  );
  if (editedAfterStart) return;

  const record: InspectCacheRecord = {
    kind: INSPECT_CACHE_KIND,
    version: INSPECT_CACHE_VERSION,
    generator: await resolveGenerator(),
    startPath: input.startPath,
    project,
    paths,
    tree,
    files,
    artifacts,
    envNames,
    env: hashEnv(trackedEnvNames(envNames, {})),
  };
  const recordPath = resolveInspectCachePath(input.startPath);
  const temporaryPath = `${recordPath}.${process.pid}.tmp`;
  try {
    await mkdir(dirname(recordPath), { recursive: true });
    await writeFile(temporaryPath, JSON.stringify(record));
    await rename(temporaryPath, recordPath);
  } catch {}
}

async function readRecord(startPath: string): Promise<InspectCacheRecord | null> {
  try {
    const record = await readJson<InspectCacheRecord>(resolveInspectCachePath(startPath));
    return record.kind === INSPECT_CACHE_KIND && record.version === INSPECT_CACHE_VERSION
      ? record
      : null;
  } catch {
    return null;
  }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function resolveGenerator(): Promise<string> {
  const ownPath = fileURLToPath(import.meta.url);
  return `${resolveInstalledPackageInfo().version}:${(await stampFiles([ownPath]))[ownPath]}`;
}

async function stampFile(path: string): Promise<FileStamp> {
  try {
    const stats = await stat(path);
    return stats.isFile() ? `${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}` : null;
  } catch {
    return null;
  }
}

async function stampFiles(paths: readonly string[]): Promise<Record<string, FileStamp>> {
  const unique = [...new Set(paths)];
  const stamps = await Promise.all(unique.map(stampFile));
  return Object.fromEntries(unique.map((path, index) => [path, stamps[index]!]));
}

async function stampTree(root: string): Promise<Record<string, string> | null> {
  const stamps: Record<string, string> = {};
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(directory, entry.name);
        const isDirectory =
          entry.isDirectory() ||
          (entry.isSymbolicLink() && (await stat(path).catch(() => null))?.isDirectory() === true);
        if (isDirectory) {
          if (!SKIPPED_DIRECTORY_NAMES.has(entry.name)) await walk(path);
          return;
        }
        stamps[relative(root, path)] = (await stampFile(path)) ?? "unreadable";
      }),
    );
  };
  try {
    await walk(root);
    return stamps;
  } catch {
    return null;
  }
}

function projectFilePaths(appRoot: string): string[] {
  const paths: string[] = [];
  for (let directory = appRoot; ; directory = dirname(directory)) {
    for (const name of PROJECT_FILE_NAMES) paths.push(join(directory, name));
    if (dirname(directory) === directory) return paths;
  }
}

async function collectEnvNames(sourcePaths: readonly string[]): Promise<string[] | null> {
  const sources = await mapWithConcurrency(sourcePaths, SOURCE_READ_CONCURRENCY, (path) =>
    readFile(path, "utf8").catch(() => null),
  );
  const names = new Set<string>();
  for (const source of sources) {
    if (source === null || ENV_MODULE_IMPORT.test(source)) return null;
    const references = source.match(ENV_REFERENCE)?.length ?? 0;
    const literals = [...source.matchAll(LITERAL_ENV_REFERENCE)];
    if (literals.length !== references) return null;
    for (const literal of literals) names.add(literal[1] ?? literal[3]!);
  }
  return [...names].sort();
}

function trackedEnvNames(
  envNames: readonly string[],
  recordedEnv: Readonly<Record<string, string | null>>,
): string[] {
  const names = new Set([...envNames, ...Object.keys(recordedEnv)]);
  for (const name of Object.keys(process.env)) {
    if (
      TRACKED_ENV_NAMES.has(name) ||
      TRACKED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
    ) {
      names.add(name);
    }
  }
  return [...names].sort();
}

function hashEnv(names: readonly string[]): Record<string, string | null> {
  return Object.fromEntries(
    names.map((name) => {
      const value = process.env[name];
      return [name, value === undefined ? null : createHash("sha256").update(value).digest("hex")];
    }),
  );
}

function sameStamps(
  expected: Readonly<Record<string, string | null>>,
  actual: Readonly<Record<string, string | null>>,
): boolean {
  const expectedKeys = Object.keys(expected);
  if (expectedKeys.length !== Object.keys(actual).length) return false;
  return expectedKeys.every((key) => Object.hasOwn(actual, key) && actual[key] === expected[key]);
}

function isInside(path: string, root: string): boolean {
  const relativePath = relative(root, path);
  return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

function modifiedAtMs(stamp: string): number {
  return Number(stamp.split(":")[1] ?? Number.POSITIVE_INFINITY);
}
