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
  /** Stable app partition embedded by a production build for local providers. */
  readonly sandboxScope?: string;
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
  /** Stable app partition shared by production build preparation and runtime. */
  readonly sandboxScope?: string;
  /**
   * Stable application root used for local sandbox template/session caches.
   * In development, `appRoot` can point at an immutable runtime snapshot
   * while sandbox state should remain scoped to the authored application.
   */
  readonly sandboxAppRoot?: string;
  /**
   * How this source is recorded in durable Workflow payloads.
   * `"development-generation"` stores a logical selector resolved from the
   * delivery's generation context — valid only where deliveries install
   * that context (the parent-owned dev World). Absent, the source is stored
   * verbatim, pinning durable work to this exact path.
   */
  readonly durableReference?: "development-generation";
}

/**
 * Creates the bundled compiled-artifact source.
 */
export function createBundledRuntimeCompiledArtifactsSource(
  sandboxScope?: string,
): RuntimeBundledCompiledArtifactsSource {
  return sandboxScope === undefined ? { kind: "bundled" } : { kind: "bundled", sandboxScope };
}

/**
 * Creates the disk-backed compiled-artifact source for one authored app root.
 */
export function createDiskRuntimeCompiledArtifactsSource(
  appRoot: string,
  options: {
    readonly durableReference?: "development-generation";
    readonly moduleMapLoaderPath?: string;
    readonly sandboxAppRoot?: string;
    readonly sandboxScope?: string;
  } = {},
): RuntimeDiskCompiledArtifactsSource {
  if (
    options.moduleMapLoaderPath !== undefined ||
    options.sandboxAppRoot !== undefined ||
    options.sandboxScope !== undefined ||
    options.durableReference !== undefined
  ) {
    return {
      appRoot,
      durableReference: options.durableReference,
      kind: "disk",
      moduleMapLoaderPath: options.moduleMapLoaderPath,
      sandboxAppRoot: options.sandboxAppRoot,
      sandboxScope: options.sandboxScope,
    };
  }

  return {
    appRoot,
    kind: "disk",
  };
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
