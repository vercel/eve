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
} from "#internal/nitro/dev-runtime-source-snapshot-local-roots.js";

export { isAuthoredSourcePath } from "#internal/nitro/dev-runtime-source-snapshot-local-roots.js";

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
  /**
   * Whether the mount target is copied into the snapshot. Copied mounts link
   * to the in-snapshot copy; all other mounts link to the real source path so
   * installed and workspace dependency code resolves in place.
   */
  readonly copied: boolean;
  readonly mountPath: string;
  readonly sourceKind: "installed" | "workspace";
  readonly sourcePath: string;
}

interface SnapshotPlanState {
  readonly appRoot: string;
  readonly authoredLocalRoots: Set<string>;
  readonly copyFiles: Set<string>;
  readonly dependencyMountsByPath: Map<
    string,
    Omit<DevelopmentSourceSnapshotDependencyMount, "copied">
  >;
  readonly localRootsToProcess: string[];
  readonly processedLocalRoots: Set<string>;
  readonly snapshotRoot: string;
  readonly snapshotSourceRoot: string;
  readonly sourceRoot: string;
  readonly tsconfigPaths: Set<string>;
}

export async function createDevelopmentSourceSnapshotPlan(input: {
  readonly appRoot: string;
  /**
   * Workspace roots that host runtime-hydrated authored source (extension
   * mount roots from the compiled manifest). They are copied into the
   * snapshot like the app root; every other workspace dependency package is
   * mounted in place instead of copied.
   */
  readonly authoredSourceRoots?: readonly string[];
  readonly snapshotRoot: string;
}): Promise<DevelopmentSourceSnapshotPlan> {
  const appRoot = resolve(input.appRoot);
  const snapshotRoot = resolve(input.snapshotRoot);
  const sourceRoot = resolveDevelopmentSourceRoot(appRoot);
  const snapshotSourceRoot = join(snapshotRoot, DEV_RUNTIME_SOURCE_DIRECTORY);
  const state: SnapshotPlanState = {
    appRoot,
    authoredLocalRoots: new Set([appRoot]),
    copyFiles: new Set(),
    dependencyMountsByPath: new Map(),
    localRootsToProcess: [appRoot],
    processedLocalRoots: new Set(),
    snapshotRoot,
    snapshotSourceRoot,
    sourceRoot,
    tsconfigPaths: new Set(),
  };

  addWorkspaceMetadataFiles(state);
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

  // Discovery walks every reachable root so the dependency-mount topology and
  // tsconfig collection match a full copy; only the directory copies are
  // narrowed to roots that host runtime-hydrated authored source.
  const copyRoots = normalizeCopyRoots(
    [...state.processedLocalRoots].filter((root) => state.authoredLocalRoots.has(root)),
  );
  const copyFiles = [...state.copyFiles]
    .filter((path) => isPathInsideOrEqual(path, sourceRoot))
    .sort((left, right) => left.localeCompare(right));
  const tsconfigPaths = [...state.tsconfigPaths]
    .filter((path) => isPathInsideOrEqual(path, sourceRoot))
    .sort((left, right) => left.localeCompare(right));
  const dependencyMounts = [...state.dependencyMountsByPath.values()]
    .map((mount) => ({
      ...mount,
      copied:
        mount.sourceKind === "workspace" &&
        [...state.authoredLocalRoots].some((root) => isPathInsideOrEqual(mount.sourcePath, root)),
    }))
    .sort((left, right) => left.mountPath.localeCompare(right.mountPath));
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

    state.authoredLocalRoots.add(localRoot);
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
    state.copyFiles.add(tsconfigPath);

    for (const localRoot of await resolveLocalTsConfigPathTargetRoots({
      configPath: tsconfigPath,
      sourceRoot: state.sourceRoot,
    })) {
      // Path-alias targets host authored source that runtime hydration can
      // read back from the snapshot, so they stay copies.
      state.authoredLocalRoots.add(localRoot);
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

/**
 * Workspace dependency packages are mounted in place rather than copied: the
 * dev runtime resolves their contents through the real tree, the same way
 * installed dependencies already resolve (vercel/eve#652). Their dependency
 * closure is still discovered — packages nested inside a copied root keep
 * their mounts — but only roots that host runtime-hydrated authored source
 * (the app, extension mounts, tsconfig path-alias targets) stay copies.
 */
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
