import { existsSync } from "node:fs";
import { lstat, readlink, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import {
  parseTsConfigObject,
  readTextFileIfExists,
  resolveTsConfigDependencyPaths,
} from "#internal/application/tsconfig-dependencies.js";

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
  readonly runtimeAppRoot: string;
  readonly snapshotRoot: string;
  readonly snapshotSourceRoot: string;
  readonly sourceRoot: string;
  readonly symlinks: readonly DevelopmentSourceSnapshotSymlink[];
  readonly tsconfigPaths: readonly string[];
  readonly watchPaths: readonly string[];
}

export interface DevelopmentSourceSnapshotSymlink {
  readonly linkPath: string;
  readonly targetKind: "external" | "local";
  readonly targetPath: string;
}

interface SnapshotPlanState {
  readonly appRoot: string;
  readonly copyFiles: Set<string>;
  readonly copyRoots: Set<string>;
  readonly localRootsToProcess: string[];
  readonly processedLocalRoots: Set<string>;
  readonly snapshotRoot: string;
  readonly snapshotSourceRoot: string;
  readonly sourceRoot: string;
  readonly symlinksByLinkPath: Map<string, DevelopmentSourceSnapshotSymlink>;
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
    localRootsToProcess: [appRoot],
    processedLocalRoots: new Set(),
    snapshotRoot,
    snapshotSourceRoot,
    sourceRoot,
    symlinksByLinkPath: new Map(),
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
    await addDependencySymlinksForRoot(state, resolvedLocalRoot);
  }

  const copyRoots = normalizeCopyRoots([...state.copyRoots]);
  const copyFiles = [...state.copyFiles]
    .filter((path) => isPathInsideOrEqual(path, sourceRoot))
    .sort((left, right) => left.localeCompare(right));
  const tsconfigPaths = [...state.tsconfigPaths]
    .filter((path) => isPathInsideOrEqual(path, sourceRoot))
    .sort((left, right) => left.localeCompare(right));
  const symlinks = [...state.symlinksByLinkPath.values()].sort((left, right) =>
    left.linkPath.localeCompare(right.linkPath),
  );
  const watchPaths = createWatchPaths({
    appRoot,
    copyFiles,
    copyRoots,
    sourceRoot,
    symlinks,
    tsconfigPaths,
  });

  return {
    appRoot,
    copyFiles,
    copyRoots,
    runtimeAppRoot: toSnapshotPath({ sourcePath: appRoot, sourceRoot, snapshotSourceRoot }),
    snapshotRoot,
    snapshotSourceRoot,
    sourceRoot,
    symlinks,
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

function resolveDevelopmentSourceRoot(appRoot: string): string {
  let currentDirectory = resolve(appRoot);

  while (true) {
    if (
      SOURCE_ROOT_MARKER_NAMES.some((markerName) => existsSync(join(currentDirectory, markerName)))
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

async function addDependencySymlinksForRoot(
  state: SnapshotPlanState,
  packageRoot: string,
): Promise<void> {
  const dependencyNames = await readPackageDependencyNames(packageRoot);

  for (const dependencyName of dependencyNames) {
    for (const nodeModulesRoot of [packageRoot, state.sourceRoot]) {
      const linkPath = joinNodeModulesPackagePath(nodeModulesRoot, dependencyName);
      await addDependencySymlink(state, linkPath);
    }
  }
}

async function addDependencySymlink(state: SnapshotPlanState, linkPath: string): Promise<void> {
  let linkStats: Awaited<ReturnType<typeof lstat>>;

  try {
    linkStats = await lstat(linkPath);
  } catch {
    return;
  }

  if (!linkStats.isSymbolicLink()) {
    return;
  }

  const targetPathCandidates = await resolveSymlinkTargetPathCandidates(linkPath);
  const localTargetPath = targetPathCandidates.find((candidate) =>
    isAuthoredSourcePath(candidate, state.sourceRoot),
  );

  if (localTargetPath !== undefined) {
    await addLocalDependencySymlink({
      linkPath,
      state,
      targetPath: localTargetPath,
    });
    return;
  }

  const externalTargetPath = targetPathCandidates.find((candidate) => existsSync(candidate));

  if (externalTargetPath === undefined) {
    return;
  }

  state.symlinksByLinkPath.set(resolve(linkPath), {
    linkPath: resolve(linkPath),
    targetKind: "external",
    targetPath: externalTargetPath,
  });
}

async function addLocalDependencySymlink(input: {
  readonly linkPath: string;
  readonly state: SnapshotPlanState;
  readonly targetPath: string;
}): Promise<void> {
  const packageRoot = await resolveNearestPackageRoot(input.targetPath, input.state.sourceRoot);

  if (packageRoot === undefined || !isAuthoredSourcePath(packageRoot, input.state.sourceRoot)) {
    return;
  }

  const { state } = input;

  enqueueLocalRoot(state, packageRoot);
  state.symlinksByLinkPath.set(resolve(input.linkPath), {
    linkPath: resolve(input.linkPath),
    targetKind: "local",
    targetPath: packageRoot,
  });
}

async function resolveSymlinkTargetPathCandidates(linkPath: string): Promise<string[]> {
  const candidates = new Set<string>();

  try {
    const declaredTarget = await readlink(linkPath);
    candidates.add(resolve(dirname(linkPath), declaredTarget));
  } catch {
    // Continue to canonical target fallback below.
  }

  try {
    candidates.add(await realpath(linkPath));
  } catch {
    // Broken symlinks are ignored by the caller.
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
  readonly sourceRoot: string;
  readonly symlinks: readonly DevelopmentSourceSnapshotSymlink[];
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

  for (const symlink of input.symlinks) {
    if (symlink.targetKind === "local" && symlink.targetPath !== input.appRoot) {
      watchPaths.add(symlink.targetPath);
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

function isPathInsideOrEqual(path: string, directory: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedDirectory = resolve(directory);

  return (
    resolvedPath === resolvedDirectory || resolvedPath.startsWith(`${resolvedDirectory}${sep}`)
  );
}

function isAuthoredSourcePath(path: string, sourceRoot: string): boolean {
  if (!isPathInsideOrEqual(path, sourceRoot)) {
    return false;
  }

  const relativePath = relative(sourceRoot, path);

  return !relativePath.split(/[\\/]/).includes("node_modules");
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
