import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import {
  EXTENSION_COMPATIBILITY_MANIFEST_FILENAME,
  readExtensionCompatibilityManifest,
} from "#compiler/extension-compatibility.js";
import {
  discoverExtensionMountDeclarations,
  type ExtensionMountDescriptor,
} from "#discover/discover-agent.js";
import { locateExtensionMountPackage } from "#discover/extensions.js";
import { createDiskProjectSource } from "#discover/project-source.js";
import { resolveDiscoveryProject } from "#discover/project.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { resolveTsConfigDependencyPaths } from "#internal/application/tsconfig-dependencies.js";
import {
  isAuthoredSourcePath,
  resolveDevelopmentSourceRoot,
} from "#internal/nitro/dev-runtime-source-snapshot.js";
import {
  buildExtensionPackage,
  tryReadExtensionBuildConfig,
  type ExtensionBuildConfig,
} from "#internal/nitro/host/build-extension.js";
import { withExtensionBuildLock } from "#internal/nitro/host/extension-build-lock.js";
import { toErrorMessage } from "#shared/errors.js";
import { parseExtensionPackageRoots } from "#shared/extension-package-contract.js";
import { isPathInsideOrEqual } from "#shared/path-inside.js";

/**
 * A mounted extension package whose authored source lives in the consuming
 * agent's workspace. Dev hosts retain it to scope extension HMR rebuilds.
 */
export interface WorkspaceExtension {
  readonly config: ExtensionBuildConfig;
  /** Canonical package root, with workspace links resolved. */
  readonly packageRoot: string;
  /** Non-source inputs that affect publisher output, such as tsconfig files. */
  readonly buildConfigPaths: readonly string[];
}

/**
 * Builds mounted source-backed workspace extensions before the consuming agent
 * compiles and returns the inputs needed to scope the next development rebuild.
 */
export async function prepareDevelopmentWorkspaceExtensions(input: {
  readonly appRoot: string;
  readonly changedPaths?: readonly string[];
  readonly previousExtensions?: readonly WorkspaceExtension[];
}): Promise<readonly WorkspaceExtension[]> {
  const extensions = await discoverWorkspaceExtensions(input.appRoot);
  const previousByPackageRoot = new Map(
    input.previousExtensions?.map((extension) => [extension.packageRoot, extension]),
  );
  const changedPaths =
    input.changedPaths === undefined
      ? undefined
      : await Promise.all(input.changedPaths.map(async (path) => await toCanonicalPath(path)));
  const force = input.previousExtensions === undefined || changedPaths?.length === 0;

  await buildInDependencyOrder(extensions, async (extension) => {
    const previous = previousByPackageRoot.get(extension.packageRoot);
    if (
      force === true ||
      previous === undefined ||
      !sameBuildInputs(previous, extension) ||
      changedPaths?.some((path) => affectsExtensionBuild(path, extension)) === true
    ) {
      await withExtensionBuildLock(extension.packageRoot, async () => {
        await buildExtensionPackage(extension.packageRoot, extension.config);
      });
    }
  });

  return extensions;
}

/**
 * Builds mounted source-backed workspace extensions before a production agent
 * build. Package manager lifecycle hooks such as `prepare` do not reliably run
 * (no-op installs and `--ignore-scripts` skip them), so production builds must
 * not assume an extension's gitignored distribution already exists. Extensions
 * whose distribution is newer than every build input are skipped. Builds hold
 * a per-package lock and recheck freshness under it, so parallel agent builds
 * that share an extension build it once.
 */
export async function buildWorkspaceExtensions(appRoot: string): Promise<void> {
  const extensions = await discoverWorkspaceExtensions(appRoot);
  await buildInDependencyOrder(extensions, async (extension) => {
    if (await isExtensionDistributionCurrent(extension)) return;
    try {
      await withExtensionBuildLock(extension.packageRoot, async () => {
        if (await isExtensionDistributionCurrent(extension)) return;
        await buildExtensionPackage(extension.packageRoot, extension.config);
      });
    } catch (error) {
      // The message embeds the build error; a cause would print it twice.
      throw new Error(
        `Failed to build workspace extension "${extension.config.packageName}" at ${extension.packageRoot}. Fix the error below, then rebuild the agent, or run \`eve extension build\` in that package directory to build it on its own.\n${toErrorMessage(error)}`,
      );
    }
  });
}

/**
 * Runs `build` for each extension once the builds of the workspace extensions
 * it declares as dependencies succeed, since building an extension reads the
 * distributions of the extensions it mounts. Independent extensions build in
 * parallel.
 */
async function buildInDependencyOrder(
  extensions: readonly WorkspaceExtension[],
  build: (extension: WorkspaceExtension) => Promise<void>,
): Promise<void> {
  const byPackageName = new Map(
    extensions.map((extension) => [extension.config.packageName, extension]),
  );
  const builds = new Map<WorkspaceExtension, Promise<void>>();
  const visiting = new Set<WorkspaceExtension>();

  const schedule = (extension: WorkspaceExtension): Promise<void> => {
    let pending = builds.get(extension);
    if (pending !== undefined) return pending;
    // A dependency cycle has no valid order; break it where it closes.
    if (visiting.has(extension)) return Promise.resolve();
    visiting.add(extension);
    const dependencies = extension.config.runtimeDependencies
      .map((name) => byPackageName.get(name))
      .filter((dependency) => dependency !== undefined)
      .map(schedule);
    visiting.delete(extension);
    pending = Promise.all(dependencies).then(async () => await build(extension));
    builds.set(extension, pending);
    return pending;
  };

  await Promise.all(extensions.map(schedule));
}

async function discoverWorkspaceExtensions(
  inputAppRoot: string,
): Promise<readonly WorkspaceExtension[]> {
  const appRoot = resolve(inputAppRoot);
  const project = await resolveDiscoveryProject(appRoot);
  const source = createDiskProjectSource();
  const discoveredMounts = await discoverExtensionMountGraph({
    agentRoot: project.agentRoot,
    source,
  });
  const workspaceSourceRoot = await toCanonicalPath(resolveDevelopmentSourceRoot(appRoot));
  const extensionsByPackageRoot = new Map<string, WorkspaceExtension>();

  for (const discovered of discoveredMounts) {
    const extension = await resolveWorkspaceExtension({
      appRoot,
      agentRoot: discovered.agentRoot,
      mount: discovered.mount,
      source,
      workspaceSourceRoot,
    });
    if (extension !== undefined) {
      extensionsByPackageRoot.set(extension.packageRoot, extension);
    }
  }

  // Building an extension reads the distributions of the workspace extensions
  // it depends on, so they must be built even when only another extension
  // mounts them.
  const pending = [...extensionsByPackageRoot.values()];
  for (let extension = pending.pop(); extension !== undefined; extension = pending.pop()) {
    for (const packageName of extension.config.runtimeDependencies) {
      const dependency = await resolveWorkspaceExtensionDependency({
        dependentRoot: extension.packageRoot,
        packageName,
        workspaceSourceRoot,
      });
      if (dependency !== undefined && !extensionsByPackageRoot.has(dependency.packageRoot)) {
        extensionsByPackageRoot.set(dependency.packageRoot, dependency);
        pending.push(dependency);
      }
    }
  }

  return [...extensionsByPackageRoot.values()].sort((left, right) =>
    left.packageRoot.localeCompare(right.packageRoot),
  );
}

async function isExtensionDistributionCurrent(extension: WorkspaceExtension): Promise<boolean> {
  const manifestPath = join(extension.config.distRoot, EXTENSION_COMPATIBILITY_MANIFEST_FILENAME);
  let builtAt: number;
  try {
    const manifest = await readExtensionCompatibilityManifest(manifestPath);
    if (manifest.builtWithEve !== resolveInstalledPackageInfo().version) return false;
    builtAt = (await stat(manifestPath)).mtimeMs;
  } catch {
    return false;
  }

  // Directory mtimes are included so deleted or renamed source files count.
  const sourceEntries = await readdir(extension.config.sourceRoot, { recursive: true });
  const inputPaths = [
    extension.config.sourceRoot,
    ...sourceEntries.map((entry) => join(extension.config.sourceRoot, entry)),
    ...extension.buildConfigPaths,
  ];
  const inputTimes = await Promise.all(
    inputPaths.map(async (path) => (await stat(path).catch(() => undefined))?.mtimeMs ?? 0),
  );
  return inputTimes.every((modifiedAt) => modifiedAt <= builtAt);
}

async function discoverExtensionMountGraph(input: {
  readonly agentRoot: string;
  readonly source: ReturnType<typeof createDiskProjectSource>;
}): Promise<readonly { agentRoot: string; mount: ExtensionMountDescriptor }[]> {
  const discovered = await discoverExtensionMountDeclarations(input);
  const mounts = discovered.mounts.map((mount) => ({ agentRoot: input.agentRoot, mount }));
  const subagentsRoot = join(input.agentRoot, "subagents");
  if ((await input.source.stat(subagentsRoot)) !== "directory") return mounts;

  const entries = await input.source.readDirectory(subagentsRoot);
  const nestedMounts = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(
        async (entry) =>
          await discoverExtensionMountGraph({
            agentRoot: join(subagentsRoot, entry.name),
            source: input.source,
          }),
      ),
  );
  return [...mounts, ...nestedMounts.flat()];
}

async function resolveWorkspaceExtension(input: {
  readonly appRoot: string;
  readonly agentRoot: string;
  readonly mount: ExtensionMountDescriptor;
  readonly source: ReturnType<typeof createDiskProjectSource>;
  readonly workspaceSourceRoot: string;
}): Promise<WorkspaceExtension | undefined> {
  const located = await locateExtensionMountPackage({
    source: input.source,
    agentRoot: input.agentRoot,
    appRoot: input.appRoot,
    mount: input.mount.mountRef,
    namespace: input.mount.namespace,
  });
  const location = located.location;
  if (location?.authoredSourceRoot === undefined) {
    return undefined;
  }
  return await readWorkspaceExtension({
    packageRoot: location.packageRoot,
    authoredSourceRoot: location.authoredSourceRoot,
    workspaceSourceRoot: input.workspaceSourceRoot,
  });
}

/** Resolves a dependency the way Node does from the dependent package's root. */
async function resolveWorkspaceExtensionDependency(input: {
  readonly dependentRoot: string;
  readonly packageName: string;
  readonly workspaceSourceRoot: string;
}): Promise<WorkspaceExtension | undefined> {
  let current = input.dependentRoot;
  while (true) {
    const packageRoot = join(current, "node_modules", input.packageName);
    const manifest = await readFile(join(packageRoot, "package.json"), "utf8").catch(
      () => undefined,
    );
    if (manifest !== undefined) {
      let pkg: { eve?: { extension?: unknown } };
      try {
        pkg = JSON.parse(manifest) as typeof pkg;
      } catch {
        return undefined;
      }
      const source = parseExtensionPackageRoots(pkg.eve?.extension)?.source;
      return source === undefined
        ? undefined
        : await readWorkspaceExtension({
            packageRoot,
            authoredSourceRoot: resolve(packageRoot, source),
            workspaceSourceRoot: input.workspaceSourceRoot,
          });
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function readWorkspaceExtension(input: {
  readonly packageRoot: string;
  readonly authoredSourceRoot: string;
  readonly workspaceSourceRoot: string;
}): Promise<WorkspaceExtension | undefined> {
  const packageRoot = await realpath(input.packageRoot).catch(() => undefined);
  if (packageRoot === undefined || !isAuthoredSourcePath(packageRoot, input.workspaceSourceRoot)) {
    return undefined;
  }

  // A package without its declared source directory ships a prebuilt
  // distribution; there is nothing to build, so its producer config is not
  // validated.
  const sourceStat = await stat(input.authoredSourceRoot).catch(() => undefined);
  if (sourceStat?.isDirectory() !== true) {
    return undefined;
  }
  const config = await tryReadExtensionBuildConfig(packageRoot);
  if (config === null) {
    return undefined;
  }
  const buildConfigPaths = [
    join(packageRoot, "package.json"),
    join(packageRoot, "tsconfig.json"),
    ...(await resolveTsConfigDependencyPaths(packageRoot)),
  ];

  return {
    config,
    packageRoot,
    buildConfigPaths: [...new Set(buildConfigPaths.map((path) => resolve(path)))].sort(
      (left, right) => left.localeCompare(right),
    ),
  };
}

function affectsExtensionBuild(changedPath: string, extension: WorkspaceExtension): boolean {
  return (
    isPathInsideOrEqual(changedPath, extension.config.sourceRoot) ||
    extension.buildConfigPaths.includes(changedPath)
  );
}

function sameBuildConfig(left: ExtensionBuildConfig, right: ExtensionBuildConfig): boolean {
  return (
    left.sourceRoot === right.sourceRoot &&
    left.distRoot === right.distRoot &&
    left.outDir === right.outDir &&
    left.packageName === right.packageName &&
    left.shortName === right.shortName &&
    left.runtimeDependencies.length === right.runtimeDependencies.length &&
    left.runtimeDependencies.every(
      (dependency, index) => dependency === right.runtimeDependencies[index],
    )
  );
}

function sameBuildInputs(left: WorkspaceExtension, right: WorkspaceExtension): boolean {
  return (
    sameBuildConfig(left.config, right.config) &&
    left.buildConfigPaths.length === right.buildConfigPaths.length &&
    left.buildConfigPaths.every((path, index) => path === right.buildConfigPaths[index])
  );
}

async function toCanonicalPath(path: string): Promise<string> {
  let candidate = resolve(path);
  const missingSegments: string[] = [];

  while (true) {
    try {
      return join(await realpath(candidate), ...missingSegments.reverse());
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) {
        return resolve(path);
      }
      missingSegments.push(basename(candidate));
      candidate = parent;
    }
  }
}
