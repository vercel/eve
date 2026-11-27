import type {
  RuntimeCompiledArtifactsSource,
  RuntimeDiskCompiledArtifactsSource,
} from "#runtime/compiled-artifacts-source.js";

/**
 * Lets one deployment serve several compiled agents. `resolve` picks the artifacts a request runs;
 * `materialize` writes the files behind a disk source on this instance, because a Workflow step that
 * resumes on a fresh instance finds the path it recorded empty.
 */
export interface CompiledArtifactsOverride {
  /** Returns the source for this request, or `undefined` to run the deployment's own build. */
  readonly resolve: (
    request: Request,
  ) =>
    | Promise<RuntimeCompiledArtifactsSource | undefined>
    | RuntimeCompiledArtifactsSource
    | undefined;
  /** Makes `source.appRoot` readable on this instance. Called before every load of a source that has a `materializationRef`, so it must be idempotent and cheap when the files are present. */
  readonly materialize: (
    source: RuntimeDiskCompiledArtifactsSource & { readonly materializationRef: string },
  ) => Promise<void>;
}

const OVERRIDE_KEY = Symbol.for("eve.compiledArtifactsOverride");

type Holder = { [OVERRIDE_KEY]?: CompiledArtifactsOverride };

export function installCompiledArtifactsOverride(override: CompiledArtifactsOverride): void {
  (globalThis as Holder)[OVERRIDE_KEY] = override;
}

export function readCompiledArtifactsOverride(): CompiledArtifactsOverride | undefined {
  return (globalThis as Holder)[OVERRIDE_KEY];
}

export async function materializeCompiledArtifactsSource(
  source: RuntimeCompiledArtifactsSource,
): Promise<void> {
  if (source.kind !== "disk" || source.materializationRef === undefined) return;
  const override = readCompiledArtifactsOverride();
  if (override === undefined) {
    throw new Error(
      `Compiled artifacts "${source.materializationRef}" need a materializer, but none is installed.`,
    );
  }
  await override.materialize({ ...source, materializationRef: source.materializationRef });
}
