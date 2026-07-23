import { join, relative, resolve, sep } from "node:path";

const DEV_RUNTIME_EXTERNAL_AGENT_DIRECTORY = ".eve/external-agent";

export class DevelopmentRuntimeSourceSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevelopmentRuntimeSourceSnapshotError";
  }
}

export interface DevelopmentSourceSnapshotPathMapping {
  readonly runtimeRoot: string;
  readonly sourceRoot: string;
}

export function createDevelopmentSourceSnapshotPathMappings(input: {
  readonly appRoot: string;
  readonly externalAgentRoot: string | undefined;
  readonly runtimeAppRoot: string;
  readonly snapshotSourceRoot: string;
  readonly sourceRoot: string;
}): DevelopmentSourceSnapshotPathMapping[] {
  const mappings: DevelopmentSourceSnapshotPathMapping[] = [
    {
      runtimeRoot: input.runtimeAppRoot,
      sourceRoot: input.appRoot,
    },
  ];

  if (input.externalAgentRoot !== undefined) {
    mappings.push({
      runtimeRoot: join(input.runtimeAppRoot, DEV_RUNTIME_EXTERNAL_AGENT_DIRECTORY),
      sourceRoot: input.externalAgentRoot,
    });
  }

  if (input.sourceRoot !== input.appRoot) {
    mappings.push({
      runtimeRoot: input.snapshotSourceRoot,
      sourceRoot: input.sourceRoot,
    });
  }

  return mappings.sort((left, right) => right.sourceRoot.length - left.sourceRoot.length);
}

export function toDevelopmentSourceSnapshotPath(input: {
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

export function toDevelopmentSourceSnapshotPlanPath(
  plan: { readonly pathMappings: readonly DevelopmentSourceSnapshotPathMapping[] },
  sourcePath: string,
): string {
  const snapshotPath = resolveDevelopmentSourceSnapshotPlanPath(plan, sourcePath);

  if (snapshotPath !== undefined) {
    return snapshotPath;
  }

  throw new DevelopmentRuntimeSourceSnapshotError(
    `Cannot map source path "${sourcePath}" into a development runtime snapshot because it is outside every planned source root.`,
  );
}

export function resolveDevelopmentSourceSnapshotPlanPath(
  plan: { readonly pathMappings: readonly DevelopmentSourceSnapshotPathMapping[] },
  sourcePath: string,
): string | undefined {
  const resolvedSourcePath = resolve(sourcePath);
  const mapping = plan.pathMappings.find((candidate) =>
    isPathInsideOrEqual(resolvedSourcePath, candidate.sourceRoot),
  );

  if (mapping === undefined) {
    return undefined;
  }

  return toDevelopmentSourceSnapshotPath({
    snapshotSourceRoot: mapping.runtimeRoot,
    sourcePath: resolvedSourcePath,
    sourceRoot: mapping.sourceRoot,
  });
}

export function isPathInsideOrEqual(path: string, directory: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedDirectory = resolve(directory);

  return (
    resolvedPath === resolvedDirectory || resolvedPath.startsWith(`${resolvedDirectory}${sep}`)
  );
}

/** Returns whether a path is authored workspace source rather than installed dependency data. */
export function isAuthoredSourcePath(path: string, sourceRoot: string): boolean {
  if (!isPathInsideOrEqual(path, sourceRoot)) {
    return false;
  }

  const relativePath = relative(sourceRoot, path);

  return !relativePath.split(/[\\/]/).includes("node_modules");
}
