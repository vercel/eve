import { existsSync, readFileSync } from "node:fs";
import { lstat, readlink, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import {
  readTextFileIfExists,
  resolveTsConfigDependencyPaths,
} from "#internal/application/tsconfig-dependencies.js";
import {
  isAuthoredSourcePath,
  isPathInsideOrEqual,
  resolveLocalTsConfigPathTargetRoots,
  resolveNearestPackageRoot,
  tsConfigDefinesPathAliases,
} from "#internal/nitro/dev-runtime-source-snapshot-tsconfig-paths.js";

export { isAuthoredSourcePath } from "#internal/nitro/dev-runtime-source-snapshot-tsconfig-paths.js";

export const DEV_RUNTIME_SOURCE_DIRECTORY = "source";

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
  readonly copyRoots: readonly string[];
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
  readonly copyRoots: Set<string>;
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
  readonly snapshotRoot: string;
}): Promise<DevelopmentSourceSnapshotPlan> {
  const appRoot = resolve(input.appRoot);
  const snapshotRoot = resolve(input.snapshotRoot);
  const sourceRoot = resolveDevelopmentSourceRoot(appRoot);
  const snapshotSourceRoot = join(snapshotRoot, DEV_RUNTIME_SOURCE_DIRECTORY);
  const state: SnapshotPlanState = {
    appRoot,
    copyFiles: new Set(),
    copyRoots: new Set(),
    dependencyMountsByPath: new Map(),
    localRootsToProcess: [appRoot],
    processedLocalRoots: new Set(),
    snapshotRoot,
    snapshotSourceRoot,
    sourceRoot,
    tsconfigPaths: new Set(),
  };

  addWorkspaceMetadataFiles(state);

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
    state.copyRoots.add(resolvedLocalRoot);

    await addTsConfigDependenciesForRoot(state, resolvedLocalRoot);
    await addDependencyMountsForRoot(state, resolvedLocalRoot);
  }

  const copyRoots = normalizeCopyRoots([...state.copyRoots]);
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
    copyRoots,
    dependencyMounts,
    sourceRoot,
    tsconfigPaths,
  });

  return {
    appRoot,
    copyFiles,
    copyRoots,
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

/** Resolves the repository/workspace boundary used for authored development sources. */
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

function addWorkspaceMetadataFiles(state: SnapshotPlanState): void {
  for (const fileName of WORKSPACE_METADATA_FILE_NAMES) {
    const path = join(state.sourceRoot, fileName);

    if (existsSync(path)) {
      state.copyFiles.add(path);
    }
  }
}

async function addTsConfigDependenciesForRoot(
  state: SnapshotPlanState,
  packageRoot: string,
): Promise<void> {
  await addTsConfigDependenciesForConfigRoot(state, packageRoot);

  // An app root without its own `package.json` (a bare `withEve` agent
  // directory) is bundled with the nearest owning package's tsconfig in
  // production, so its path aliases must resolve inside the snapshot too
  // (vercel/eve#1242).
  const declarationRoot = resolveDependencyDeclarationRoot(packageRoot, state.sourceRoot);

  if (declarationRoot === packageRoot) {
    return;
  }

  const declaresPathAliases = await addTsConfigDependenciesForConfigRoot(state, declarationRoot);

  // Alias targets such as `"@/*": ["./*"]` resolve against the owning
  // package root, so that whole package must be part of the snapshot for
  // dev bundling to match production resolution (vercel/eve#1242). The
  // source root itself is never copied wholesale, matching
  // `resolveLocalTsConfigPathTargetRoot`.
  if (declaresPathAliases && declarationRoot !== state.sourceRoot) {
    enqueueLocalRoot(state, declarationRoot);
  }
}

async function addTsConfigDependenciesForConfigRoot(
  state: SnapshotPlanState,
  configRoot: string,
): Promise<boolean> {
  const tsconfigPaths = await resolveTsConfigDependencyPaths(configRoot);
  let declaresPathAliases = false;

  for (const tsconfigPath of tsconfigPaths) {
    if (!isPathInsideOrEqual(tsconfigPath, state.sourceRoot)) {
      continue;
    }

    state.tsconfigPaths.add(tsconfigPath);
    state.copyFiles.add(tsconfigPath);

    if (await tsConfigDefinesPathAliases(tsconfigPath)) {
      declaresPathAliases = true;
    }

    for (const localRoot of await resolveLocalTsConfigPathTargetRoots({
      configPath: tsconfigPath,
      sourceRoot: state.sourceRoot,
    })) {
      enqueueLocalRoot(state, localRoot);
    }
  }

  return declaresPathAliases;
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

/**
 * An app root without its own `package.json` (a bare `withEve` agent
 * directory) resolves imports through the nearest owning package. Its
 * dependency declarations live there, not at the app root (vercel/eve#1151).
 */
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

/**
 * Node resolution walks every ancestor `node_modules`. Mirror that walk up to
 * the source boundary so hoisted installs — npm/yarn workspaces and
 * intermediate monorepo levels — are materialized in the snapshot instead of
 * only the package's own and the source root's `node_modules`
 * (vercel/eve#1151).
 */
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

  // A package root outside the boundary keeps the pre-existing two-point
  // behavior: its own node_modules plus the source root's.
  roots.add(resolve(packageRoot));
  roots.add(boundary);

  return [...roots];
}

/**
 * npm and Yarn mark the workspace root only in `package.json` (`workspaces`),
 * unlike pnpm's `pnpm-workspace.yaml`. Without recognizing it, a gitless npm
 * workspace collapses the source root to the app root and hides the hoisted
 * `node_modules` level from the snapshot (vercel/eve#1151).
 */
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

  // Installation topology does not express ownership: npm and hoisted Yarn
  // use directories where pnpm uses links for the same installed package.
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
  } catch {
    // Continue to canonical target fallback below.
  }

  try {
    candidates.add(await realpath(mountPath));
  } catch {
    // Broken dependency entries are ignored by the caller.
  }

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

function normalizeCopyRoots(copyRoots: readonly string[]): string[] {
  const sortedRoots = [...new Set(copyRoots.map((path) => resolve(path)))].sort((left, right) => {
    const lengthDifference = left.length - right.length;
    return lengthDifference === 0 ? left.localeCompare(right) : lengthDifference;
  });
  const normalizedRoots: string[] = [];

  for (const root of sortedRoots) {
    if (normalizedRoots.some((existingRoot) => isPathInsideOrEqual(root, existingRoot))) {
      continue;
    }

    normalizedRoots.push(root);
  }

  return normalizedRoots.sort((left, right) => left.localeCompare(right));
}

function createWatchPaths(input: {
  readonly appRoot: string;
  readonly copyFiles: readonly string[];
  readonly copyRoots: readonly string[];
  readonly dependencyMounts: readonly DevelopmentSourceSnapshotDependencyMount[];
  readonly sourceRoot: string;
  readonly tsconfigPaths: readonly string[];
}): string[] {
  const watchPaths = new Set<string>([
    join(input.appRoot, "package.json"),
    ...input.copyFiles,
    ...input.tsconfigPaths,
  ]);

  for (const copyRoot of input.copyRoots) {
    if (copyRoot !== input.appRoot) {
      watchPaths.add(copyRoot);
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
