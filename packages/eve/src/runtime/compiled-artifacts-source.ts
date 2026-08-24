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
interface RuntimeDiskCompiledArtifactsSourceBase {
  readonly appRoot: string;
  readonly kind: "disk";
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

export type RuntimeDiskCompiledArtifactsSource = RuntimeDiskCompiledArtifactsSourceBase &
  (
    | {
        readonly moduleMapLoaderKind?: undefined;
        readonly moduleMapLoaderPath?: undefined;
      }
    | {
        /** Package-owned loader used to hydrate the validated manifest. */
        readonly moduleMapLoaderPath: string;
        /** Whether hydration reads live authored source or an immutable generation. */
        readonly moduleMapLoaderKind: "authored-source" | "materialized-generation";
      }
  );

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
  options:
    | {
        readonly durableReference?: "development-generation";
        readonly moduleMapLoaderKind?: undefined;
        readonly moduleMapLoaderPath?: undefined;
        readonly sandboxAppRoot?: string;
      }
    | {
        readonly durableReference?: "development-generation";
        readonly moduleMapLoaderKind: "authored-source" | "materialized-generation";
        readonly moduleMapLoaderPath: string;
        readonly sandboxAppRoot?: string;
      } = {},
): RuntimeDiskCompiledArtifactsSource {
  if (options.moduleMapLoaderKind !== undefined) {
    const source: {
      appRoot: string;
      durableReference?: "development-generation";
      kind: "disk";
      moduleMapLoaderKind: "authored-source" | "materialized-generation";
      moduleMapLoaderPath: string;
      sandboxAppRoot?: string;
    } = {
      appRoot,
      kind: "disk",
      moduleMapLoaderKind: options.moduleMapLoaderKind,
      moduleMapLoaderPath: options.moduleMapLoaderPath,
    };
    if (options.durableReference !== undefined) {
      source.durableReference = options.durableReference;
    }
    if (options.sandboxAppRoot !== undefined) {
      source.sandboxAppRoot = options.sandboxAppRoot;
    }
    return source;
  }

  if (options.sandboxAppRoot !== undefined || options.durableReference !== undefined) {
    const source: {
      appRoot: string;
      durableReference?: "development-generation";
      kind: "disk";
      sandboxAppRoot?: string;
    } = {
      appRoot,
      kind: "disk",
    };
    if (options.durableReference !== undefined) {
      source.durableReference = options.durableReference;
    }
    if (options.sandboxAppRoot !== undefined) {
      source.sandboxAppRoot = options.sandboxAppRoot;
    }
    return source;
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
    return `disk:${source.appRoot}:${source.moduleMapLoaderKind}:${source.moduleMapLoaderPath}`;
  }

  return `disk:${source.appRoot}`;
}
