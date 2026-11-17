import { existsSync, readFileSync } from "node:fs";
import { lstat, readlink, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import {
  readTextFileIfExists,
  resolveTsConfigDependencyPaths,
} from "#internal/application/tsconfig-dependencies.js";
import { isPathInsideOrEqual } from "#shared/path-inside.js";
import {
  isAuthoredSourcePath,
  resolveLocalTsConfigPathTargetRoots,
  resolveNearestPackageRoot,
} from "#internal/nitro/dev-runtime-source-snapshot-local-roots.js";

export { isAuthoredSourcePath } from "#internal/nitro/dev-runtime-source-snapshot-local-roots.js";

const DEV_RUNTIME_SOURCE_DIRECTORY = "source";

const SOURCE_ROOT_MARKER_NAMES = [".git", "pnpm-workspace.yaml"] as const;
const WORKSPACE_METADATA_FILE_NAMES = [
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  ".npmrc",
] as const;
const PACKAGE_DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

export class DevelopmentRuntimeSourceSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevelopmentRuntimeSourceSnapshotError";
  }
}

export interface DevelopmentSourceSnapshotPlan {
  readonly appRoot: string;
  readonly copyFiles: readonly string[];
  readonly dependencyMounts: readonly DevelopmentSourceSnapshotDependencyMount[];
  readonly runtimeAppRoot: string;
  readonly snapshotRoot: string;
  readonly snapshotSourceRoot: string;
  readonly sourceRoot: string;
  readonly tsconfigPaths: readonly string[];
  readonly watchPaths: readonly string[];
}

export interface DevelopmentSourceSnapshotDependencyMount {
  readonly mountPath: string;
  readonly sourceKind: "installed" | "workspace";
  readonly sourcePath: string;
}

interface SnapshotPlanState {
  readonly appRoot: string;
  readonly copyFiles: Set<string>;
  readonly dependencyMountsByPath: Map<string, DevelopmentSourceSnapshotDependencyMount>;
  readonly localRootsToProcess: string[];
  readonly processedLocalRoots: Set<string>;
  readonly snapshotRoot: string;
  readonly snapshotSourceRoot: string;
  readonly sourceRoot: string;
  readonly tsconfigPaths: Set<string>;
}

export async function createDevelopmentSourceSnapshotPlan(input: {
  readonly appRoot: string;
  readonly authoredSourceRoots?: readonly string[];
  readonly snapshotRoot: string;
}): Promise<DevelopmentSourceSnapshotPlan> {
  const appRoot = resolve(input.appRoot);
  const snapshotRoot = resolve(input.snapshotRoot);
  const sourceRoot = resolveDevelopmentSourceRoot(appRoot);
  const snapshotSourceRoot = join(snapshotRoot, DEV_RUNTIME_SOURCE_DIRECTORY);
  const state: SnapshotPlanState = {
    appRoot,
    copyFiles: new Set(),
    dependencyMountsByPath: new Map(),
    localRootsToProcess: [appRoot],
    processedLocalRoots: new Set(),
    snapshotRoot,
    snapshotSourceRoot,
    sourceRoot,
    tsconfigPaths: new Set(),
  };

  const appPackageJsonPath = join(appRoot, "package.json");
  if (existsSync(appPackageJsonPath)) {
    state.copyFiles.add(appPackageJsonPath);
  }
  await addAuthoredSourceRoots(state, input.authoredSourceRoots ?? []);

  while (state.localRootsToProcess.length > 0) {
    const localRoot = state.localRootsToProcess.shift();

    if (localRoot === undefined) {
      continue;
    }

    const resolvedLocalRoot = resolve(localRoot);

    if (
      state.processedLocalRoots.has(resolvedLocalRoot) ||
      !isAuthoredSourcePath(resolvedLocalRoot, sourceRoot)
    ) {
      continue;
    }

    state.processedLocalRoots.add(resolvedLocalRoot);

    await addTsConfigDependenciesForRoot(state, resolvedLocalRoot);
    await addDependencyMountsForRoot(state, resolvedLocalRoot);
  }

  const copyFiles = [...state.copyFiles]
    .filter((path) => isPathInsideOrEqual(path, sourceRoot))
    .sort((left, right) => left.localeCompare(right));
  const tsconfigPaths = [...state.tsconfigPaths]
    .filter((path) => isPathInsideOrEqual(path, sourceRoot))
    .sort((left, right) => left.localeCompare(right));
  const dependencyMounts = [...state.dependencyMountsByPath.values()].sort((left, right) =>
    left.mountPath.localeCompare(right.mountPath),
  );
  const watchPaths = createWatchPaths({
    appRoot,
    copyFiles,
    dependencyMounts,
    localRoots: [...state.processedLocalRoots],
    sourceRoot,
    tsconfigPaths,
  });

  return {
    appRoot,
    copyFiles,
    dependencyMounts,
    runtimeAppRoot: toSnapshotPath({ sourcePath: appRoot, sourceRoot, snapshotSourceRoot }),
    snapshotRoot,
    snapshotSourceRoot,
    sourceRoot,
    tsconfigPaths,
    watchPaths,
  };
}

export async function resolveDevelopmentSourceSnapshotWatchPaths(
  appRoot: string,
): Promise<string[]> {
  const snapshotRoot = join(resolve(appRoot), ".eve", "dev-runtime", "__watch-plan__");
  const plan = await createDevelopmentSourceSnapshotPlan({
    appRoot,
    snapshotRoot,
  });

  return [...plan.watchPaths];
}

export function toDevelopmentSourceSnapshotPath(input: {
  readonly snapshotSourceRoot: string;
  readonly sourcePath: string;
  readonly sourceRoot: string;
}): string {
  return toSnapshotPath(input);
}

export function resolveDevelopmentSourceRoot(appRoot: string): string {
  let currentDirectory = resolve(appRoot);

  while (true) {
    if (
      SOURCE_ROOT_MARKER_NAMES.some((markerName) =>
        existsSync(join(currentDirectory, markerName)),
      ) ||
      isWorkspaceManifestRoot(currentDirectory)
    ) {
      return currentDirectory;
    }

    const parentDirectory = dirname(currentDirectory);

    if (parentDirectory === currentDirectory) {
      return resolve(appRoot);
    }

    currentDirectory = parentDirectory;
  }
}

async function addAuthoredSourceRoots(
  state: SnapshotPlanState,
  authoredSourceRoots: readonly string[],
): Promise<void> {
  for (const authoredSourceRoot of authoredSourceRoots) {
    const resolvedRoot = resolve(authoredSourceRoot);

    if (!isAuthoredSourcePath(resolvedRoot, state.sourceRoot)) {
      continue;
    }

    const localRoot =
      (await resolveNearestPackageRoot(resolvedRoot, state.sourceRoot)) ?? resolvedRoot;

    enqueueLocalRoot(state, localRoot);
  }
}

async function addTsConfigDependenciesForRoot(
  state: SnapshotPlanState,
  packageRoot: string,
): Promise<void> {
  const tsconfigPaths = await resolveTsConfigDependencyPaths(packageRoot);

  for (const tsconfigPath of tsconfigPaths) {
    if (!isPathInsideOrEqual(tsconfigPath, state.sourceRoot)) {
      continue;
    }

    state.tsconfigPaths.add(tsconfigPath);

    for (const localRoot of await resolveLocalTsConfigPathTargetRoots({
      configPath: tsconfigPath,
      sourceRoot: state.sourceRoot,
    })) {
      enqueueLocalRoot(state, localRoot);
    }
  }
}

async function addDependencyMountsForRoot(
  state: SnapshotPlanState,
  packageRoot: string,
): Promise<void> {
  const declarationRoot = resolveDependencyDeclarationRoot(packageRoot, state.sourceRoot);
  const dependencyNames = await readPackageDependencyNames(declarationRoot);

  for (const dependencyName of dependencyNames) {
    for (const nodeModulesRoot of listAncestorNodeModulesRoots(packageRoot, state.sourceRoot)) {
      const mountPath = joinNodeModulesPackagePath(nodeModulesRoot, dependencyName);
      await addDependencyMount(state, mountPath);
    }
  }
}

function resolveDependencyDeclarationRoot(packageRoot: string, sourceRoot: string): string {
  let currentDirectory = resolve(packageRoot);
  const boundary = resolve(sourceRoot);

  while (isPathInsideOrEqual(currentDirectory, boundary)) {
    if (existsSync(join(currentDirectory, "package.json"))) {
      return currentDirectory;
    }

    const parentDirectory = dirname(currentDirectory);

    if (parentDirectory === currentDirectory) {
      break;
    }

    currentDirectory = parentDirectory;
  }

  return packageRoot;
}

function listAncestorNodeModulesRoots(packageRoot: string, sourceRoot: string): string[] {
  const boundary = resolve(sourceRoot);
  const roots = new Set<string>();
  let currentDirectory = resolve(packageRoot);

  while (isPathInsideOrEqual(currentDirectory, boundary)) {
    roots.add(currentDirectory);

    const parentDirectory = dirname(currentDirectory);

    if (parentDirectory === currentDirectory) {
      break;
    }

    currentDirectory = parentDirectory;
  }

  roots.add(resolve(packageRoot));
  roots.add(boundary);

  return [...roots];
}

function isWorkspaceManifestRoot(directory: string): boolean {
  const packageJsonPath = join(directory, "package.json");

  if (!existsSync(packageJsonPath)) {
    return false;
  }

  try {
    const packageJson: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    return isObjectRecord(packageJson) && packageJson["workspaces"] !== undefined;
  } catch {
    return false;
  }
}

async function addDependencyMount(state: SnapshotPlanState, mountPath: string): Promise<void> {
  let mountStats: Awaited<ReturnType<typeof lstat>>;

  try {
    mountStats = await lstat(mountPath);
  } catch {
    return;
  }

  if (!mountStats.isDirectory() && !mountStats.isSymbolicLink()) {
    return;
  }

  const sourcePathCandidates = await resolveDependencySourcePathCandidates(mountPath);
  const workspaceSourcePath = sourcePathCandidates.find((candidate) =>
    isAuthoredSourcePath(candidate, state.sourceRoot),
  );

  if (workspaceSourcePath !== undefined) {
    await addWorkspaceDependencyMount({
      mountPath,
      state,
      sourcePath: workspaceSourcePath,
    });
    return;
  }

  const installedSourcePath = sourcePathCandidates.find((candidate) => existsSync(candidate));

  if (installedSourcePath === undefined) {
    return;
  }

  state.dependencyMountsByPath.set(resolve(mountPath), {
    mountPath: resolve(mountPath),
    sourceKind: "installed",
    sourcePath: installedSourcePath,
  });
}

async function addWorkspaceDependencyMount(input: {
  readonly mountPath: string;
  readonly state: SnapshotPlanState;
  readonly sourcePath: string;
}): Promise<void> {
  const packageRoot = await resolveNearestPackageRoot(input.sourcePath, input.state.sourceRoot);

  if (packageRoot === undefined || !isAuthoredSourcePath(packageRoot, input.state.sourceRoot)) {
    return;
  }

  const { state } = input;

  enqueueLocalRoot(state, packageRoot);
  state.dependencyMountsByPath.set(resolve(input.mountPath), {
    mountPath: resolve(input.mountPath),
    sourceKind: "workspace",
    sourcePath: packageRoot,
  });
}

async function resolveDependencySourcePathCandidates(mountPath: string): Promise<string[]> {
  const candidates = new Set<string>();

  try {
    const declaredTarget = await readlink(mountPath);
    candidates.add(resolve(dirname(mountPath), declaredTarget));
  } catch {}

  try {
    candidates.add(await realpath(mountPath));
  } catch {}

  return [...candidates];
}

function enqueueLocalRoot(state: SnapshotPlanState, localRoot: string): void {
  const resolvedLocalRoot = resolve(localRoot);

  if (
    state.processedLocalRoots.has(resolvedLocalRoot) ||
    state.localRootsToProcess.includes(resolvedLocalRoot) ||
    !isAuthoredSourcePath(resolvedLocalRoot, state.sourceRoot)
  ) {
    return;
  }

  state.localRootsToProcess.push(resolvedLocalRoot);
}

async function readPackageDependencyNames(packageRoot: string): Promise<string[]> {
  const packageJsonPath = join(packageRoot, "package.json");
  const packageJsonSource = await readTextFileIfExists(packageJsonPath);

  if (packageJsonSource === undefined) {
    return [];
  }

  let packageJson: unknown;

  try {
    packageJson = JSON.parse(packageJsonSource);
  } catch {
    return [];
  }

  if (!isObjectRecord(packageJson)) {
    return [];
  }

  const dependencyNames = new Set<string>();

  for (const fieldName of PACKAGE_DEPENDENCY_FIELDS) {
    const dependencies = packageJson[fieldName];

    if (!isObjectRecord(dependencies)) {
      continue;
    }

    for (const dependencyName of Object.keys(dependencies)) {
      dependencyNames.add(dependencyName);
    }
  }

  return [...dependencyNames].sort((left, right) => left.localeCompare(right));
}

function createWatchPaths(input: {
  readonly appRoot: string;
  readonly copyFiles: readonly string[];
  readonly dependencyMounts: readonly DevelopmentSourceSnapshotDependencyMount[];
  readonly localRoots: readonly string[];
  readonly sourceRoot: string;
  readonly tsconfigPaths: readonly string[];
}): string[] {
  const watchPaths = new Set<string>([
    join(input.appRoot, "package.json"),
    ...input.copyFiles,
    ...input.tsconfigPaths,
  ]);

  for (const localRoot of input.localRoots) {
    if (localRoot !== input.appRoot) {
      watchPaths.add(localRoot);
    }
  }

  for (const mount of input.dependencyMounts) {
    if (mount.sourceKind === "workspace" && mount.sourcePath !== input.appRoot) {
      watchPaths.add(mount.sourcePath);
    }
  }

  if (input.sourceRoot !== input.appRoot) {
    for (const fileName of WORKSPACE_METADATA_FILE_NAMES) {
      const path = join(input.sourceRoot, fileName);

      if (existsSync(path)) {
        watchPaths.add(path);
      }
    }
  }

  return [...watchPaths].sort((left, right) => left.localeCompare(right));
}

function joinNodeModulesPackagePath(packageRoot: string, dependencyName: string): string {
  return join(packageRoot, "node_modules", ...dependencyName.split("/"));
}

function toSnapshotPath(input: {
  readonly snapshotSourceRoot: string;
  readonly sourcePath: string;
  readonly sourceRoot: string;
}): string {
  if (!isPathInsideOrEqual(input.sourcePath, input.sourceRoot)) {
    throw new DevelopmentRuntimeSourceSnapshotError(
      `Cannot map source path "${input.sourcePath}" into a development runtime snapshot because it is outside source root "${input.sourceRoot}".`,
    );
  }

  return join(input.snapshotSourceRoot, relative(input.sourceRoot, input.sourcePath));
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
