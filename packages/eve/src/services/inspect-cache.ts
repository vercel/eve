import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { CompileAgentResult } from "#compiler/compile-agent.js";
import type { CompiledAgentManifest } from "#compiler/manifest.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { resolveTsConfigDependencyPaths } from "#internal/application/tsconfig-dependencies.js";
import { authoredModuleConditions } from "#internal/authored-module-conditions.js";
import {
  findAuthoredPackageRoot,
  isAuthoredSourcePath,
} from "#internal/authored-package-boundary.js";
import { mapWithConcurrency } from "#shared/map-with-concurrency.js";
import { isPathInsideOrEqual } from "#shared/path-inside.js";

const RECORD_KIND = "eve-inspect-cache-v2";
const RECENT_EDIT_WINDOW_MS = 2_000;
const SKIPPED_DIRECTORIES = new Set([
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
const PROJECT_FILES = [
  "bun.lock",
  "bun.lockb",
  "jsconfig.json",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "yarn.lock",
];
const CONFIG_VARIANT = /^[jt]sconfig\..+\.json$/;
const TRACKED_ENV = /^(?:EVE_|VERCEL|NODE_ENV$|NODE_OPTIONS$)/;
const ENV_ACCESS = /\bprocess\.env\b/g;
const LITERAL_ENV_ACCESS = /\bprocess\.env(?:\.([A-Za-z_$][\w$]*)|\[\s*(["'])([^"'\\]+)\2\s*\])/g;
const INDIRECT_ENV_ACCESS =
  /\bprocess\s*(?:\?\.|\[)|\{[^}]*\benv\b[^}]*\}\s*=\s*(?:globalThis\s*\.\s*)?process\b|\b(?:from|require\()\s*["'](?:node:)?process["']/;

type Stamps = Record<string, string | null>;

interface InspectCacheRecord {
  readonly kind: typeof RECORD_KIND;
  readonly generator: string;
  readonly result: Pick<CompileAgentResult, "paths" | "project">;
  readonly roots: readonly string[];
  readonly stamps: Stamps;
  readonly env: Stamps;
}

export function resolveInspectCachePath(appRoot: string): string {
  return join(appRoot, ".eve", "cache", "inspect.json");
}

export async function readCachedCompile(appRoot: string): Promise<CompileAgentResult | null> {
  try {
    const record = await readJson<InspectCacheRecord>(resolveInspectCachePath(appRoot));
    if (record.kind !== RECORD_KIND || record.generator !== (await generator())) return null;
    if (!same(record.env, hashEnv(Object.keys(record.env)))) return null;
    const files = Object.keys(record.stamps).filter((path) => !insideAny(path, record.roots));
    if (!same(record.stamps, await stampAll(record.roots, files))) return null;
    const { paths, project } = record.result;
    const [manifest, metadata, { diagnostics }] = await Promise.all([
      readJson<CompileAgentResult["manifest"]>(paths.compiledManifestPath),
      readJson<CompileAgentResult["metadata"]>(paths.compileMetadataPath),
      readJson<Pick<CompileAgentResult, "diagnostics">>(paths.diagnosticsPath),
    ]);
    return { diagnostics, manifest, metadata, paths, project };
  } catch {
    return null;
  }
}

export async function writeCachedCompile(input: {
  readonly appRoot: string;
  readonly result: CompileAgentResult;
  readonly moduleIds: ReadonlySet<string>;
  readonly startedAtMs: number;
}): Promise<void> {
  const { diagnostics, manifest, metadata, paths, project } = input.result;
  if (metadata.status !== "ready") return;
  if (diagnostics.some(({ code }) => code === "compile/model-metadata-unavailable")) return;

  const sources = [...input.moduleIds]
    .map((moduleId) => moduleId.split("?")[0]!)
    .filter(isAuthoredSourcePath);
  const envNames = await literalEnvNames(sources);
  if (envNames === null) return;

  const roots = [
    ...new Set([manifest, ...manifest.subagents.map(({ agent }) => agent)].flatMap(mountRoots)),
  ];
  const artifacts = [
    paths.compiledManifestPath,
    paths.compileMetadataPath,
    paths.diagnosticsPath,
    paths.discoveryManifestPath,
    paths.moduleMapPath,
  ];
  const files = [
    ...sources,
    ...artifacts,
    ...(await projectFiles(project.appRoot)),
    ...(await resolveTsConfigDependencyPaths(project.appRoot)),
    ...packageManifests([...roots, ...sources]),
  ];
  const stamps = await stampAll(
    roots,
    files.filter((path) => !insideAny(path, roots)),
  );
  if ([...sources, ...artifacts].some((path) => stamps[path] === null)) return;
  const editedDuringCompile = Object.entries(stamps).some(
    ([path, stamp]) =>
      stamp !== null &&
      !artifacts.includes(path) &&
      Number(stamp.split(":")[1]) >= input.startedAtMs - RECENT_EDIT_WINDOW_MS,
  );
  if (editedDuringCompile) return;

  const record: InspectCacheRecord = {
    kind: RECORD_KIND,
    generator: await generator(),
    result: { paths, project },
    roots,
    stamps,
    env: hashEnv(envNames),
  };
  const recordPath = resolveInspectCachePath(input.appRoot);
  const temporaryPath = `${recordPath}.${process.pid}.tmp`;
  try {
    await mkdir(dirname(recordPath), { recursive: true });
    await writeFile(temporaryPath, JSON.stringify(record));
    await rename(temporaryPath, recordPath);
  } catch {}
}

function mountRoots(node: Pick<CompiledAgentManifest, "agentRoot" | "extensionMounts">): string[] {
  return [node.agentRoot, ...node.extensionMounts.map(({ sourceRoot }) => sourceRoot)];
}

async function generator(): Promise<string> {
  const ownPath = fileURLToPath(import.meta.url);
  return [
    resolveInstalledPackageInfo().version,
    await stamp(ownPath),
    ...authoredModuleConditions(),
  ].join("\0");
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function stamp(path: string): Promise<string | null> {
  const stats = await stat(path).catch(() => null);
  return stats?.isFile() === true ? `${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}` : null;
}

async function stampAll(roots: readonly string[], files: readonly string[]): Promise<Stamps> {
  const stamps: Stamps = {};
  const record = async (path: string) => {
    stamps[path] = await stamp(path);
  };
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory).catch(() => []);
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(directory, entry);
        if ((await stat(path).catch(() => null))?.isDirectory() !== true) return record(path);
        if (!SKIPPED_DIRECTORIES.has(entry)) await walk(path);
      }),
    );
  };
  await Promise.all([...roots.map(walk), ...[...new Set(files)].map(record)]);
  return stamps;
}

async function projectFiles(appRoot: string): Promise<string[]> {
  const files: string[] = [];
  for (let directory = appRoot; ; directory = dirname(directory)) {
    const entries = await readdir(directory).catch(() => []);
    const names = [...PROJECT_FILES, ...entries.filter((name) => CONFIG_VARIANT.test(name))];
    files.push(...names.map((name) => join(directory, name)));
    if (dirname(directory) === directory) return files;
  }
}

function packageManifests(paths: readonly string[]): string[] {
  return [...new Set(paths.map(dirname))].flatMap((directory) => {
    const packageRoot = findAuthoredPackageRoot(directory);
    return packageRoot === undefined ? [] : [join(packageRoot, "package.json")];
  });
}

async function literalEnvNames(sources: readonly string[]): Promise<string[] | null> {
  const texts = await mapWithConcurrency(sources, 64, (path) =>
    readFile(path, "utf8").catch(() => null),
  );
  const names = new Set<string>();
  for (const text of texts) {
    if (text === null || INDIRECT_ENV_ACCESS.test(text)) return null;
    const literals = [...text.matchAll(LITERAL_ENV_ACCESS)];
    if (literals.length !== (text.match(ENV_ACCESS)?.length ?? 0)) return null;
    for (const literal of literals) names.add(literal[1] ?? literal[3]!);
  }
  return [...names];
}

function hashEnv(names: readonly string[]): Stamps {
  const tracked = Object.keys(process.env).filter((name) => TRACKED_ENV.test(name));
  return Object.fromEntries(
    [...new Set([...names, ...tracked])].map((name) => {
      const value = process.env[name];
      return [name, value === undefined ? null : createHash("sha256").update(value).digest("hex")];
    }),
  );
}

function same(expected: Stamps, actual: Stamps): boolean {
  const keys = Object.keys(expected);
  return (
    keys.length === Object.keys(actual).length &&
    keys.every((key) => Object.hasOwn(actual, key) && actual[key] === expected[key])
  );
}

function insideAny(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => isPathInsideOrEqual(path, root));
}
