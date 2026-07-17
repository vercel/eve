import { realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

import {
  discoverExtensionMountDeclarations,
  type ExtensionMountDescriptor,
} from "#discover/discover-agent.js";
import { locateExtensionMountPackage } from "#discover/extensions.js";
import { createDiskProjectSource } from "#discover/project-source.js";
import { resolveDiscoveryProject } from "#discover/project.js";
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

/** Build inputs retained with a prepared dev host for path-scoped extension HMR. */
export interface DevelopmentWorkspaceExtension {
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
  readonly previousExtensions?: readonly DevelopmentWorkspaceExtension[];
}): Promise<readonly DevelopmentWorkspaceExtension[]> {
  const appRoot = resolve(input.appRoot);
  const project = await resolveDiscoveryProject(appRoot);
  const source = createDiskProjectSource();
  const discovered = await discoverExtensionMountDeclarations({
    agentRoot: project.agentRoot,
    source,
  });
  const workspaceSourceRoot = await toCanonicalPath(resolveDevelopmentSourceRoot(appRoot));
  const extensionsByPackageRoot = new Map<string, DevelopmentWorkspaceExtension>();

  for (const mount of discovered.mounts) {
    const extension = await resolveWorkspaceExtension({
      appRoot,
      agentRoot: project.agentRoot,
      mount,
      source,
      workspaceSourceRoot,
    });
    if (extension !== undefined) {
      extensionsByPackageRoot.set(extension.packageRoot, extension);
    }
  }

  const extensions = [...extensionsByPackageRoot.values()].sort((left, right) =>
    left.packageRoot.localeCompare(right.packageRoot),
  );
  const previousByPackageRoot = new Map(
    input.previousExtensions?.map((extension) => [extension.packageRoot, extension]),
  );
  const changedPaths =
    input.changedPaths === undefined
      ? undefined
      : await Promise.all(input.changedPaths.map(async (path) => await toCanonicalPath(path)));
  const force = input.previousExtensions === undefined || changedPaths?.length === 0;

  await Promise.all(
    extensions.map(async (extension) => {
      const previous = previousByPackageRoot.get(extension.packageRoot);
      if (
        force === true ||
        previous === undefined ||
        !sameBuildInputs(previous, extension) ||
        changedPaths?.some((path) => affectsExtensionBuild(path, extension)) === true
      ) {
        await buildExtensionPackage(extension.packageRoot, extension.config);
      }
    }),
  );

  return extensions;
}

async function resolveWorkspaceExtension(input: {
  readonly appRoot: string;
  readonly agentRoot: string;
  readonly mount: ExtensionMountDescriptor;
  readonly source: ReturnType<typeof createDiskProjectSource>;
  readonly workspaceSourceRoot: string;
}): Promise<DevelopmentWorkspaceExtension | undefined> {
  const located = await locateExtensionMountPackage({
    source: input.source,
    agentRoot: input.agentRoot,
    appRoot: input.appRoot,
    mount: input.mount.mountRef,
    namespace: input.mount.namespace,
  });
  if (located.location?.authoredSourceRoot === undefined) {
    return undefined;
  }

  const packageRoot = await realpath(located.location.packageRoot).catch(() => undefined);
  if (packageRoot === undefined || !isAuthoredSourcePath(packageRoot, input.workspaceSourceRoot)) {
    return undefined;
  }

  const config = await tryReadExtensionBuildConfig(packageRoot);
  if (config === null) {
    return undefined;
  }
  const sourceStat = await stat(config.sourceRoot).catch(() => undefined);
  if (sourceStat?.isDirectory() !== true) {
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

function affectsExtensionBuild(
  changedPath: string,
  extension: DevelopmentWorkspaceExtension,
): boolean {
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

function sameBuildInputs(
  left: DevelopmentWorkspaceExtension,
  right: DevelopmentWorkspaceExtension,
): boolean {
  return (
    sameBuildConfig(left.config, right.config) &&
    left.buildConfigPaths.length === right.buildConfigPaths.length &&
    left.buildConfigPaths.every((path, index) => path === right.buildConfigPaths[index])
  );
}

function isPathInsideOrEqual(path: string, directory: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedDirectory = resolve(directory);
  return (
    resolvedPath === resolvedDirectory || resolvedPath.startsWith(`${resolvedDirectory}${sep}`)
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
