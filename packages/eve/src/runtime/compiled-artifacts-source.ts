/**
 * Runtime-owned compiled-artifact source for one resolved agent graph.
 */
export type RuntimeCompiledArtifactsSource =
  | RuntimeBundledCompiledArtifactsSource
  | RuntimeDiskCompiledArtifactsSource;

/**
 * Bundled compiled artifacts installed in-process beside runtime workflow
 * entrypoints.
 */
export interface RuntimeBundledCompiledArtifactsSource {
  readonly kind: "bundled";
}

/**
 * Disk-backed compiled artifacts rooted at one authored application.
 */
export interface RuntimeDiskCompiledArtifactsSource {
  readonly appRoot: string;
  readonly kind: "disk";
  /**
   * Native filesystem path to the package-owned authored-source module map
   * loader. When set, the runtime loads modules directly from authored
   * source instead of the bundled-compiled module map. Omitted in deployed
   * runtimes, where the module map must come from the compiled artifact
   * emitted by the build.
   */
  readonly moduleMapLoaderPath?: string;
  /**
   * Stable application root used for local sandbox template/session caches.
   * In development, `appRoot` can point at an immutable runtime snapshot
   * while sandbox state should remain scoped to the authored application.
   */
  readonly sandboxAppRoot?: string;
}

/**
 * Creates the bundled compiled-artifact source.
 */
export function createBundledRuntimeCompiledArtifactsSource(): RuntimeBundledCompiledArtifactsSource {
  return {
    kind: "bundled",
  };
}

/**
 * Creates the disk-backed compiled-artifact source for one authored app root.
 */
export function createDiskRuntimeCompiledArtifactsSource(
  appRoot: string,
  options: {
    readonly moduleMapLoaderPath?: string;
    readonly sandboxAppRoot?: string;
  } = {},
): RuntimeDiskCompiledArtifactsSource {
  if (options.moduleMapLoaderPath !== undefined || options.sandboxAppRoot !== undefined) {
    return {
      appRoot,
      kind: "disk",
      moduleMapLoaderPath: options.moduleMapLoaderPath,
      sandboxAppRoot: options.sandboxAppRoot,
    };
  }

  return {
    appRoot,
    kind: "disk",
  };
}

/**
 * Returns the disk-backed app root when one exists for the artifact source.
 */
export function getRuntimeCompiledArtifactsAppRoot(
  source: RuntimeCompiledArtifactsSource,
): string | undefined {
  return source.kind === "disk" ? source.appRoot : undefined;
}

/**
 * Returns the stable application root to use for local sandbox cache scope.
 */
export function getRuntimeCompiledArtifactsSandboxAppRoot(
  source: RuntimeCompiledArtifactsSource,
): string | undefined {
  return source.kind === "disk" ? (source.sandboxAppRoot ?? source.appRoot) : undefined;
}

/**
 * Returns the stable cache key for one runtime artifact source.
 */
export function getRuntimeCompiledArtifactsCacheKey(
  source: RuntimeCompiledArtifactsSource,
): string {
  if (source.kind !== "disk") {
    return "bundled";
  }

  if (source.moduleMapLoaderPath !== undefined) {
    return `disk:${source.appRoot}:authored-source:${source.moduleMapLoaderPath}`;
  }

  return `disk:${source.appRoot}`;
}
