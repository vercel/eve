export type RuntimeCompiledArtifactsSource =
  | RuntimeBundledCompiledArtifactsSource
  | RuntimeDiskCompiledArtifactsSource;

export interface RuntimeBundledCompiledArtifactsSource {
  readonly kind: "bundled";
  readonly sandboxScope?: string;
}

export interface RuntimeDiskCompiledArtifactsSource {
  readonly appRoot: string;
  readonly kind: "disk";
  readonly moduleMapLoaderPath?: string;
  readonly sandboxScope?: string;
  readonly sandboxAppRoot?: string;
  readonly durableReference?: "development-generation";
}

export function createBundledRuntimeCompiledArtifactsSource(
  sandboxScope?: string,
): RuntimeBundledCompiledArtifactsSource {
  return sandboxScope === undefined ? { kind: "bundled" } : { kind: "bundled", sandboxScope };
}

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

export function getRuntimeCompiledArtifactsSandboxAppRoot(
  source: RuntimeCompiledArtifactsSource,
): string | undefined {
  return source.kind === "disk" ? (source.sandboxAppRoot ?? source.appRoot) : undefined;
}

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
