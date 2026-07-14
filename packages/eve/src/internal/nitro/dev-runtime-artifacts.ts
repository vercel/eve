import { randomUUID } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, type Dirent } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import type { CompileAgentResult } from "#compiler/compile-agent.js";
import { copyDevelopmentSourceSnapshot } from "#internal/nitro/dev-runtime-source-snapshot-copy.js";
import { createDevelopmentSourceSnapshotPlan } from "#internal/nitro/dev-runtime-source-snapshot.js";
import { renameWithTransientBusyRetry } from "#shared/rename-with-retry.js";

const DEV_RUNTIME_ARTIFACTS_DIRECTORY = "dev-runtime";
const DEV_RUNTIME_ARTIFACTS_ACTIVATED_MARKER = "activated";
const DEV_RUNTIME_ARTIFACTS_POINTER_VERSION = 2;
const DEV_RUNTIME_SNAPSHOT_RECENT_WINDOW_MS = 15 * 60 * 1000;
const DEV_RUNTIME_SNAPSHOT_RETAIN_COUNT = 5;
const DEV_RUNTIME_WORKFLOW_DATA_MAX_SCAN_BYTES = 1024 * 1024;
const TERMINAL_WORKFLOW_RUN_STATUSES = new Set(["completed", "failed", "cancelled", "canceled"]);

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
  readonly sourceRoot: string;
}

export interface ActiveDevelopmentRuntimeArtifactsSnapshot {
  readonly runtimeAppRoot: string;
  readonly snapshotRoot: string;
}

export interface DevelopmentRuntimeArtifactsActivation {
  commit(): void;
  rollback(): Promise<void>;
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
    sourceRoot: sourceSnapshotPlan.sourceRoot,
  };
}

/**
 * Moves the dev runtime pointer so future sessions use a staged snapshot.
 */
export async function activateDevelopmentRuntimeArtifactsSnapshot(input: {
  readonly appRoot: string;
  readonly snapshot: DevelopmentRuntimeArtifactsSnapshot;
}): Promise<void> {
  const activation = await activateDevelopmentRuntimeArtifactsSnapshotTransaction(input);
  activation.commit();
}

export async function activateDevelopmentRuntimeArtifactsSnapshotTransaction(input: {
  readonly appRoot: string;
  readonly snapshot: DevelopmentRuntimeArtifactsSnapshot;
}): Promise<DevelopmentRuntimeArtifactsActivation> {
  const markerPath = join(input.snapshot.snapshotRoot, DEV_RUNTIME_ARTIFACTS_ACTIVATED_MARKER);
  const pointerPath = resolveDevelopmentRuntimeArtifactsPointerPath(input.appRoot);
  const previousPointerSource = await readOptionalFile(pointerPath);

  try {
    await writeFile(markerPath, "");
    await writeDevelopmentRuntimeArtifactsPointer(input);
  } catch (error) {
    throw await rollbackFailedActivation({
      cause: error,
      markerPath,
      pointerPath,
      previousPointerSource,
    });
  }

  let settled = false;
  return {
    commit() {
      settled = true;
    },
    async rollback() {
      if (settled) {
        return;
      }
      settled = true;
      const rollbackError = await restoreDevelopmentRuntimeArtifactsActivation({
        markerPath,
        pointerPath,
        previousPointerSource,
      });
      if (rollbackError !== undefined) {
        throw rollbackError;
      }
    },
  };
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

export function readActiveDevelopmentRuntimeArtifactsSnapshot(
  appRoot: string,
): ActiveDevelopmentRuntimeArtifactsSnapshot | undefined {
  const pointer = readDevelopmentRuntimeArtifactsPointer(
    resolveDevelopmentRuntimeArtifactsPointerPath(appRoot),
  );
  if (pointer === undefined || pointer.version === 1) {
    return undefined;
  }
  return {
    runtimeAppRoot: pointer.runtimeAppRoot,
    snapshotRoot: pointer.snapshotRoot,
  };
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
  const protectedPaths = [
    ...collectProtectedSnapshotPaths(pointer),
    ...(await collectWorkflowDataSnapshotPaths({ appRoot: input.appRoot, snapshotsDirectory })),
  ];
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
        existsSync(join(snapshot.path, DEV_RUNTIME_ARTIFACTS_ACTIVATED_MARKER)) ||
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

async function collectWorkflowDataSnapshotPaths(input: {
  readonly appRoot: string;
  readonly snapshotsDirectory: string;
}): Promise<readonly string[]> {
  const workflowDataDirectory = join(input.appRoot, ".workflow-data");
  const snapshotPaths = new Set<string>();

  await collectSnapshotPathsFromDirectory({
    directory: workflowDataDirectory,
    snapshotPaths,
    snapshotsDirectory: input.snapshotsDirectory,
  });

  return [...snapshotPaths];
}

async function collectSnapshotPathsFromDirectory(input: {
  readonly directory: string;
  readonly snapshotPaths: Set<string>;
  readonly snapshotsDirectory: string;
}): Promise<void> {
  let entries: Dirent<string>[];

  try {
    entries = await readdir(input.directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }

    throw error;
  }

  await Promise.all(
    entries.map(async (entry) => {
      const path = join(input.directory, entry.name);

      if (entry.isDirectory()) {
        await collectSnapshotPathsFromDirectory({
          directory: path,
          snapshotPaths: input.snapshotPaths,
          snapshotsDirectory: input.snapshotsDirectory,
        });
        return;
      }

      if (!entry.isFile()) {
        return;
      }

      const fileStats = await stat(path);
      // Local workflow run payloads are small; keep this best-effort scan cheap.
      if (fileStats.size > DEV_RUNTIME_WORKFLOW_DATA_MAX_SCAN_BYTES) {
        return;
      }

      const source = await readFile(path, "utf8");
      if (!shouldScanWorkflowDataSource(source)) {
        return;
      }

      for (const snapshotPath of collectSnapshotPathsFromText(source, input.snapshotsDirectory)) {
        input.snapshotPaths.add(snapshotPath);
      }
    }),
  );
}

function collectSnapshotPathsFromText(
  source: string,
  snapshotsDirectory: string,
): readonly string[] {
  const snapshotPaths = new Set<string>();
  const normalizedSnapshotsDirectory = snapshotsDirectory.replaceAll("\\", "/");
  const pattern = new RegExp(`${escapeRegExp(normalizedSnapshotsDirectory)}/([^/"'\\s]+)`, "gu");
  const normalizedSource = source.replaceAll("\\\\", "/").replaceAll("\\", "/");

  for (const match of normalizedSource.matchAll(pattern)) {
    const snapshotName = match[1];

    if (snapshotName !== undefined && snapshotName.length > 0) {
      snapshotPaths.add(join(snapshotsDirectory, snapshotName));
    }
  }

  return [...snapshotPaths];
}

function shouldScanWorkflowDataSource(source: string): boolean {
  const value = parseJsonObject(source);
  if (value === undefined) {
    return true;
  }

  const status = value.status;
  return typeof status !== "string" || !TERMINAL_WORKFLOW_RUN_STATUSES.has(status);
}

function parseJsonObject(source: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(source) as unknown;
    return isObjectRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function pathsOverlap(left: string, right: string): boolean {
  return isPathInsideOrEqual(left, right) || isPathInsideOrEqual(right, left);
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
  const pointer: DevelopmentRuntimeArtifactsPointerV2 = {
    appRoot: input.appRoot,
    kind: "eve-dev-runtime-artifacts-pointer",
    runtimeAppRoot: input.snapshot.runtimeAppRoot,
    snapshotRoot: input.snapshot.snapshotRoot,
    version: DEV_RUNTIME_ARTIFACTS_POINTER_VERSION,
  };

  await writeDevelopmentRuntimeArtifactsPointerSource(
    pointerPath,
    `${JSON.stringify(pointer, null, 2)}\n`,
  );
}

async function writeDevelopmentRuntimeArtifactsPointerSource(
  pointerPath: string,
  source: string,
): Promise<void> {
  const temporaryPointerPath = `${pointerPath}.${randomUUID()}.tmp`;
  await mkdir(dirname(pointerPath), { recursive: true });
  await writeFile(temporaryPointerPath, source);
  try {
    await renameWithTransientBusyRetry(temporaryPointerPath, pointerPath);
  } catch (error) {
    await rm(temporaryPointerPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function rollbackFailedActivation(input: {
  readonly cause: unknown;
  readonly markerPath: string;
  readonly pointerPath: string;
  readonly previousPointerSource: string | undefined;
}): Promise<unknown> {
  const rollbackError = await restoreDevelopmentRuntimeArtifactsActivation(input);
  if (rollbackError === undefined) {
    return input.cause;
  }
  return new AggregateError(
    [input.cause, rollbackError],
    "Development runtime activation and rollback failed.",
    { cause: input.cause },
  );
}

async function restoreDevelopmentRuntimeArtifactsActivation(input: {
  readonly markerPath: string;
  readonly pointerPath: string;
  readonly previousPointerSource: string | undefined;
}): Promise<AggregateError | undefined> {
  const restoration = await Promise.allSettled([
    input.previousPointerSource === undefined
      ? rm(input.pointerPath, { force: true })
      : writeDevelopmentRuntimeArtifactsPointerSource(
          input.pointerPath,
          input.previousPointerSource,
        ),
    rm(input.markerPath, { force: true }),
  ]);
  const errors = restoration.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (errors.length === 0) {
    return undefined;
  }
  return new AggregateError(errors, "Failed to restore development runtime activation.");
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
