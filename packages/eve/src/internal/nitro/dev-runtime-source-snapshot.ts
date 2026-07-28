import { existsSync, readFileSync } from "node:fs";
import { lstat, readlink, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  parseTsConfigObject,
  readTextFileIfExists,
  resolveTsConfigDependencyPaths,
} from "#internal/application/tsconfig-dependencies.js";
import {
  createDevelopmentSourceSnapshotPathMappings,
  isAuthoredSourcePath,
  isPathInsideOrEqual,
  toDevelopmentSourceSnapshotPath,
  type DevelopmentSourceSnapshotPathMapping,
} from "#internal/nitro/dev-runtime-source-snapshot-paths.js";

export {
  DevelopmentRuntimeSourceSnapshotError,
  isAuthoredSourcePath,
  resolveDevelopmentSourceSnapshotPlanPath,
  toDevelopmentSourceSnapshotPath,
  toDevelopmentSourceSnapshotPlanPath,
  type DevelopmentSourceSnapshotPathMapping,
} from "#internal/nitro/dev-runtime-source-snapshot-paths.js";

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

export interface DevelopmentSourceSnapshotPlan {
  readonly appRoot: string;
  readonly copyFiles: readonly string[];
  readonly copyRoots: readonly string[];
  readonly dependencyMounts: readonly DevelopmentSourceSnapshotDependencyMount[];
  readonly pathMappings: readonly DevelopmentSourceSnapshotPathMapping[];
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
  readonly agentRoot?: string;
  readonly appRoot: string;
  readonly snapshotRoot: string;
}): Promise<DevelopmentSourceSnapshotPlan> {
  const appRoot = resolve(input.appRoot);
  const agentRoot = input.agentRoot === undefined ? undefined : resolve(input.agentRoot);
  const snapshotRoot = resolve(input.snapshotRoot);
  const sourceRoot = resolveDevelopmentSourceRoot(appRoot);
  const snapshotSourceRoot = join(snapshotRoot, DEV_RUNTIME_SOURCE_DIRECTORY);
  const runtimeAppRoot = toDevelopmentSourceSnapshotPath({
    snapshotSourceRoot,
    sourcePath: appRoot,
    sourceRoot,
  });
  const externalAgentRoot =
    agentRoot !== undefined && !isPathInsideOrEqual(agentRoot, appRoot) ? agentRoot : undefined;
  const pathMappings = createDevelopmentSourceSnapshotPathMappings({
    appRoot,
    externalAgentRoot,
    runtimeAppRoot,
    snapshotSourceRoot,
    sourceRoot,
  });
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
  if (externalAgentRoot !== undefined && !copyRoots.includes(externalAgentRoot)) {
    // An ancestor copy keeps its own target mapping, so the agent root must
    // remain an explicit copy even when another planned root contains it.
    copyRoots.push(externalAgentRoot);
    copyRoots.sort((left, right) => left.localeCompare(right));
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
    pathMappings,
    runtimeAppRoot,
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

async function resolveLocalTsConfigPathTargetRoots(input: {
  readonly configPath: string;
  readonly sourceRoot: string;
}): Promise<string[]> {
  const source = await readTextFileIfExists(input.configPath);

  if (source === undefined) {
    return [];
  }

  const parsedConfig = parseTsConfigObject(source);
  const compilerOptions = isObjectRecord(parsedConfig?.compilerOptions)
    ? parsedConfig.compilerOptions
    : undefined;
  const paths = isObjectRecord(compilerOptions?.paths) ? compilerOptions.paths : undefined;

  if (compilerOptions === undefined || paths === undefined) {
    return [];
  }

  const baseDirectory =
    typeof compilerOptions.baseUrl === "string"
      ? resolve(dirname(input.configPath), compilerOptions.baseUrl)
      : dirname(input.configPath);
  const localRoots = new Set<string>();

  for (const targets of Object.values(paths)) {
    if (!Array.isArray(targets)) {
      continue;
    }

    for (const target of targets) {
      if (typeof target !== "string" || target.length === 0) {
        continue;
      }

      const localRoot = await resolveLocalTsConfigPathTargetRoot({
        baseDirectory,
        sourceRoot: input.sourceRoot,
        target,
      });

      if (localRoot !== undefined) {
        localRoots.add(localRoot);
      }
    }
  }

  return [...localRoots].sort((left, right) => left.localeCompare(right));
}

async function resolveLocalTsConfigPathTargetRoot(input: {
  readonly baseDirectory: string;
  readonly sourceRoot: string;
  readonly target: string;
}): Promise<string | undefined> {
  const hasWildcard = input.target.includes("*");
  const targetPrefix = hasWildcard
    ? input.target.slice(0, input.target.indexOf("*"))
    : input.target;

  if (targetPrefix.length === 0 || targetPrefix === "." || targetPrefix === "./") {
    return undefined;
  }

  const resolvedTarget = resolve(input.baseDirectory, targetPrefix);

  if (!isAuthoredSourcePath(resolvedTarget, input.sourceRoot)) {
    return undefined;
  }

  const existingTarget = await resolveExistingPathOrAncestor({
    path: resolvedTarget,
    stopDirectory: input.sourceRoot,
  });

  if (existingTarget === undefined) {
    return undefined;
  }

  const packageRoot = await resolveNearestPackageRoot(existingTarget, input.sourceRoot);

  if (packageRoot !== undefined && packageRoot !== input.sourceRoot) {
    return packageRoot;
  }

  if (hasWildcard) {
    return undefined;
  }

  return existingTarget === input.sourceRoot ? undefined : existingTarget;
}

async function resolveExistingPathOrAncestor(input: {
  readonly path: string;
  readonly stopDirectory: string;
}): Promise<string | undefined> {
  let currentPath = resolve(input.path);

  while (isAuthoredSourcePath(currentPath, input.stopDirectory)) {
    if (existsSync(currentPath)) {
      return currentPath;
    }

    const parentPath = dirname(currentPath);

    if (parentPath === currentPath) {
      return undefined;
    }

    currentPath = parentPath;
  }

  return undefined;
}

async function resolveNearestPackageRoot(
  path: string,
  sourceRoot: string,
): Promise<string | undefined> {
  let currentDirectory = resolve(path);

  try {
    const stats = await lstat(currentDirectory);

    if (!stats.isDirectory()) {
      currentDirectory = dirname(currentDirectory);
    }
  } catch {
    currentDirectory = dirname(currentDirectory);
  }

  while (isAuthoredSourcePath(currentDirectory, sourceRoot)) {
    if (existsSync(join(currentDirectory, "package.json"))) {
      return currentDirectory;
    }

    const parentDirectory = dirname(currentDirectory);

    if (parentDirectory === currentDirectory) {
      return undefined;
    }

    currentDirectory = parentDirectory;
  }

  return undefined;
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

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
