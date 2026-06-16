import { randomUUID } from "node:crypto";
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, type Dirent } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import type { CompileAgentResult } from "#compiler/compile-agent.js";
import { copyDevelopmentSourceSnapshot } from "#internal/nitro/dev-runtime-source-snapshot-copy.js";
import { createDevelopmentSourceSnapshotPlan } from "#internal/nitro/dev-runtime-source-snapshot.js";

const DEV_RUNTIME_ARTIFACTS_DIRECTORY = "dev-runtime";
const DEV_RUNTIME_ARTIFACTS_POINTER_VERSION = 2;
const DEV_RUNTIME_SNAPSHOT_RECENT_WINDOW_MS = 15 * 60 * 1000;
const DEV_RUNTIME_SNAPSHOT_RETAIN_COUNT = 5;

interface DevelopmentRuntimeArtifactsPointerV1 {
  readonly appRoot: string;
  readonly kind: "eve-dev-runtime-artifacts-pointer";
  readonly version: 1;
}

interface DevelopmentRuntimeArtifactsPointerV2 {
  readonly appRoot: string;
  readonly kind: "eve-dev-runtime-artifacts-pointer";
  readonly runtimeAppRoot: string;
  readonly snapshotRoot: string;
  readonly version: typeof DEV_RUNTIME_ARTIFACTS_POINTER_VERSION;
}

export interface DevelopmentRuntimeArtifactsRevision {
  readonly revision: string;
}

export interface DevelopmentRuntimeArtifactsSnapshot {
  readonly runtimeAppRoot: string;
  readonly snapshotRoot: string;
  readonly snapshotSourceRoot: string;
}

/**
 * Resolves the dev-server pointer that records the latest runtime artifact
 * snapshot for new sessions.
 */
export function resolveDevelopmentRuntimeArtifactsPointerPath(appRoot: string): string {
  return join(appRoot, ".eve", DEV_RUNTIME_ARTIFACTS_DIRECTORY, "current.json");
}

function resolveDevelopmentRuntimeArtifactsSnapshotsDirectory(appRoot: string): string {
  return join(appRoot, ".eve", DEV_RUNTIME_ARTIFACTS_DIRECTORY, "snapshots");
}

/**
 * Publishes one immutable dev runtime snapshot and points future sessions at it.
 */
export async function publishDevelopmentRuntimeArtifactsSnapshot(
  compileResult: CompileAgentResult,
): Promise<DevelopmentRuntimeArtifactsSnapshot> {
  const snapshot = await stageDevelopmentRuntimeArtifactsSnapshot(compileResult);
  await activateDevelopmentRuntimeArtifactsSnapshot({
    appRoot: compileResult.project.appRoot,
    snapshot,
  });
  return snapshot;
}

/**
 * Stages one immutable dev runtime snapshot without moving the latest pointer.
 */
export async function stageDevelopmentRuntimeArtifactsSnapshot(
  compileResult: CompileAgentResult,
): Promise<DevelopmentRuntimeArtifactsSnapshot> {
  const snapshotRoot = join(
    resolveDevelopmentRuntimeArtifactsSnapshotsDirectory(compileResult.project.appRoot),
    `${Date.now().toString(36)}-${randomUUID()}`,
  );
  const sourceSnapshotPlan = await createDevelopmentSourceSnapshotPlan({
    appRoot: compileResult.project.appRoot,
    snapshotRoot,
  });

  try {
    await copyDevelopmentSourceSnapshot(sourceSnapshotPlan);
    await cp(
      compileResult.paths.compileDirectoryPath,
      join(sourceSnapshotPlan.runtimeAppRoot, ".eve", "compile"),
      {
        recursive: true,
      },
    );
    await rewriteSnapshotCompiledManifest({
      appRoot: compileResult.project.appRoot,
      manifestPath: join(
        sourceSnapshotPlan.runtimeAppRoot,
        ".eve",
        "compile",
        "compiled-agent-manifest.json",
      ),
      runtimeAppRoot: sourceSnapshotPlan.runtimeAppRoot,
    });
    await validateSnapshotCompiledManifestRoots({
      manifestPath: join(
        sourceSnapshotPlan.runtimeAppRoot,
        ".eve",
        "compile",
        "compiled-agent-manifest.json",
      ),
      runtimeAppRoot: sourceSnapshotPlan.runtimeAppRoot,
    });
  } catch (error) {
    await rm(snapshotRoot, { force: true, recursive: true }).catch(() => {});
    throw error;
  }

  return {
    runtimeAppRoot: sourceSnapshotPlan.runtimeAppRoot,
    snapshotRoot,
    snapshotSourceRoot: sourceSnapshotPlan.snapshotSourceRoot,
  };
}

/**
 * Moves the dev runtime pointer so future sessions use a staged snapshot.
 */
export async function activateDevelopmentRuntimeArtifactsSnapshot(input: {
  readonly appRoot: string;
  readonly snapshot: DevelopmentRuntimeArtifactsSnapshot;
}): Promise<void> {
  await writeDevelopmentRuntimeArtifactsPointer(input);
}

/**
 * Reads the latest dev runtime snapshot root when the dev server has one.
 */
export function readDevelopmentRuntimeArtifactsSnapshotRoot(
  pointerPath: string | undefined,
): string | undefined {
  const pointer = readDevelopmentRuntimeArtifactsPointer(pointerPath);

  if (pointer === undefined) {
    return undefined;
  }

  if (pointer.version === 1) {
    return pointer.appRoot;
  }

  return pointer.runtimeAppRoot;
}

/**
 * Reads a revision token for the latest dev runtime artifact snapshot.
 */
export function readDevelopmentRuntimeArtifactsRevision(
  appRoot: string,
): DevelopmentRuntimeArtifactsRevision {
  const snapshotRoot = readDevelopmentRuntimeArtifactsSnapshotRoot(
    resolveDevelopmentRuntimeArtifactsPointerPath(appRoot),
  );
  return {
    revision: snapshotRoot ?? appRoot,
  };
}

/**
 * Starts best-effort cleanup for stale dev-runtime snapshots without delaying
 * `eve dev` startup or rebuild handling.
 */
export function pruneDevelopmentRuntimeArtifactsSnapshotsInBackground(appRoot: string): void {
  void pruneDevelopmentRuntimeArtifactsSnapshots({ appRoot }).catch((error) => {
    console.warn(`[eve:dev] failed to prune stale runtime snapshots: ${formatErrorMessage(error)}`);
  });
}

export async function pruneDevelopmentRuntimeArtifactsSnapshots(input: {
  readonly appRoot: string;
  readonly now?: number;
  readonly recentWindowMs?: number;
  readonly retainCount?: number;
}): Promise<void> {
  const snapshotsDirectory = resolveDevelopmentRuntimeArtifactsSnapshotsDirectory(input.appRoot);
  const pointer = readDevelopmentRuntimeArtifactsPointer(
    resolveDevelopmentRuntimeArtifactsPointerPath(input.appRoot),
  );
  const protectedPaths = collectProtectedSnapshotPaths(pointer);
  const now = input.now ?? Date.now();
  const recentWindowMs = input.recentWindowMs ?? DEV_RUNTIME_SNAPSHOT_RECENT_WINDOW_MS;
  const retainCount = input.retainCount ?? DEV_RUNTIME_SNAPSHOT_RETAIN_COUNT;

  let entries: Dirent<string>[];
  try {
    entries = await readdir(snapshotsDirectory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  const snapshots = (
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const path = join(snapshotsDirectory, entry.name);
          return {
            path,
            mtimeMs: (await stat(path)).mtimeMs,
          };
        }),
    )
  ).sort((left, right) => right.mtimeMs - left.mtimeMs);

  await Promise.all(
    snapshots.map(async (snapshot, index) => {
      if (
        index < retainCount ||
        now - snapshot.mtimeMs <= recentWindowMs ||
        protectedPaths.some((protectedPath) => pathsOverlap(snapshot.path, protectedPath))
      ) {
        return;
      }

      await rm(snapshot.path, { force: true, recursive: true });
    }),
  );
}

function readDevelopmentRuntimeArtifactsPointer(
  pointerPath: string | undefined,
): DevelopmentRuntimeArtifactsPointerV1 | DevelopmentRuntimeArtifactsPointerV2 | undefined {
  if (pointerPath === undefined || !existsSync(pointerPath)) {
    return undefined;
  }

  try {
    const pointer = JSON.parse(readFileSync(pointerPath, "utf8")) as Partial<
      DevelopmentRuntimeArtifactsPointerV1 | DevelopmentRuntimeArtifactsPointerV2
    >;

    if (
      pointer.kind !== "eve-dev-runtime-artifacts-pointer" ||
      typeof pointer.version !== "number"
    ) {
      return undefined;
    }

    if (
      pointer.version === 1 &&
      typeof pointer.appRoot === "string" &&
      pointer.appRoot.length > 0
    ) {
      return {
        appRoot: pointer.appRoot,
        kind: "eve-dev-runtime-artifacts-pointer",
        version: 1,
      };
    }

    if (
      pointer.version === DEV_RUNTIME_ARTIFACTS_POINTER_VERSION &&
      typeof pointer.appRoot === "string" &&
      typeof pointer.runtimeAppRoot === "string" &&
      pointer.runtimeAppRoot.length > 0 &&
      typeof pointer.snapshotRoot === "string" &&
      pointer.snapshotRoot.length > 0
    ) {
      return {
        appRoot: pointer.appRoot,
        kind: "eve-dev-runtime-artifacts-pointer",
        runtimeAppRoot: pointer.runtimeAppRoot,
        snapshotRoot: pointer.snapshotRoot,
        version: DEV_RUNTIME_ARTIFACTS_POINTER_VERSION,
      };
    }

    return undefined;
  } catch {
    return undefined;
  }
}

function collectProtectedSnapshotPaths(
  pointer: DevelopmentRuntimeArtifactsPointerV1 | DevelopmentRuntimeArtifactsPointerV2 | undefined,
): readonly string[] {
  if (pointer === undefined) {
    return [];
  }

  if (pointer.version === 1) {
    return [pointer.appRoot];
  }

  return [pointer.runtimeAppRoot, pointer.snapshotRoot];
}

function pathsOverlap(left: string, right: string): boolean {
  return isPathInsideOrEqual(left, right) || isPathInsideOrEqual(right, left);
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function rewriteSnapshotCompiledManifest(input: {
  readonly appRoot: string;
  readonly manifestPath: string;
  readonly runtimeAppRoot: string;
}): Promise<void> {
  const manifest = JSON.parse(await readFile(input.manifestPath, "utf8")) as unknown;
  const rewritten = rewriteManifestRoots({
    appRoot: input.appRoot,
    runtimeAppRoot: input.runtimeAppRoot,
    value: manifest,
  });

  await writeFile(input.manifestPath, `${JSON.stringify(rewritten, null, 2)}\n`);
}

function rewriteManifestRoots(input: {
  readonly appRoot: string;
  readonly runtimeAppRoot: string;
  readonly value: unknown;
}): unknown {
  if (Array.isArray(input.value)) {
    return input.value.map((value) => rewriteManifestRoots({ ...input, value }));
  }

  if (input.value === null || typeof input.value !== "object") {
    return input.value;
  }

  const rewritten: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.value)) {
    if (typeof value === "string" && (key === "appRoot" || key === "agentRoot")) {
      rewritten[key] = rewritePathWithinAppRoot({
        appRoot: input.appRoot,
        path: value,
        runtimeAppRoot: input.runtimeAppRoot,
      });
      continue;
    }

    rewritten[key] = rewriteManifestRoots({
      appRoot: input.appRoot,
      runtimeAppRoot: input.runtimeAppRoot,
      value,
    });
  }

  return rewritten;
}

function rewritePathWithinAppRoot(input: {
  readonly appRoot: string;
  readonly path: string;
  readonly runtimeAppRoot: string;
}): string {
  if (!isPathInsideOrEqual(input.path, input.appRoot)) {
    return input.path;
  }

  const relativePath = relative(input.appRoot, input.path);
  if (relativePath.length === 0) {
    return input.runtimeAppRoot;
  }

  return join(input.runtimeAppRoot, relativePath);
}

async function writeDevelopmentRuntimeArtifactsPointer(input: {
  readonly appRoot: string;
  readonly snapshot: DevelopmentRuntimeArtifactsSnapshot;
}): Promise<void> {
  const pointerPath = resolveDevelopmentRuntimeArtifactsPointerPath(input.appRoot);
  const temporaryPointerPath = `${pointerPath}.${randomUUID()}.tmp`;
  const pointer: DevelopmentRuntimeArtifactsPointerV2 = {
    appRoot: input.appRoot,
    kind: "eve-dev-runtime-artifacts-pointer",
    runtimeAppRoot: input.snapshot.runtimeAppRoot,
    snapshotRoot: input.snapshot.snapshotRoot,
    version: DEV_RUNTIME_ARTIFACTS_POINTER_VERSION,
  };

  await mkdir(dirname(pointerPath), { recursive: true });
  await writeFile(temporaryPointerPath, `${JSON.stringify(pointer, null, 2)}\n`);
  try {
    await rename(temporaryPointerPath, pointerPath);
  } catch (error) {
    await rm(temporaryPointerPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function validateSnapshotCompiledManifestRoots(input: {
  readonly manifestPath: string;
  readonly runtimeAppRoot: string;
}): Promise<void> {
  const manifest = JSON.parse(await readFile(input.manifestPath, "utf8")) as unknown;
  const rootPaths = collectManifestRootPaths(manifest);

  for (const path of rootPaths) {
    if (isPathInsideOrEqual(path, input.runtimeAppRoot)) {
      continue;
    }

    throw new Error(
      `Development runtime snapshot manifest root "${path}" is outside runtime app root "${input.runtimeAppRoot}".`,
    );
  }
}

function collectManifestRootPaths(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectManifestRootPaths(entry));
  }

  if (value === null || typeof value !== "object") {
    return [];
  }

  const paths: string[] = [];

  for (const [key, entryValue] of Object.entries(value)) {
    if ((key === "appRoot" || key === "agentRoot") && typeof entryValue === "string") {
      paths.push(entryValue);
      continue;
    }

    paths.push(...collectManifestRootPaths(entryValue));
  }

  return paths;
}

function isPathInsideOrEqual(path: string, directory: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedDirectory = resolve(directory);

  return (
    resolvedPath === resolvedDirectory || resolvedPath.startsWith(`${resolvedDirectory}${sep}`)
  );
}
