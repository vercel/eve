import {
  getRuntimeCompiledArtifactsCacheKey,
  type RuntimeCompiledArtifactsSource,
} from "#runtime/compiled-artifacts-source.js";
import { resolveRuntimeCompilerArtifactPaths } from "#runtime/loaders/artifact-paths.js";
import { loadCompileMetadata } from "#runtime/loaders/compile-metadata.js";

/**
 * Resolves a cache key for one compiled-artifact source that also fingerprints
 * the current compiled source graph when metadata is available.
 *
 * This lets long-lived processes keep cache hits across turns while still
 * invalidating naturally after recompilation under the same app root.
 */
export async function resolveRuntimeCompiledArtifactsVersionedCacheKey(
  source: RuntimeCompiledArtifactsSource,
): Promise<string> {
  const baseKey = getRuntimeCompiledArtifactsCacheKey(source);
  const compileMetadataMtimeMs = await resolveCompileMetadataMtimeMs(source);

  try {
    const metadata = await loadCompileMetadata({
      compiledArtifactsSource: source,
    });
    const sourceGraphHash = metadata?.discovery.sourceGraphHash;

    if (sourceGraphHash === undefined || sourceGraphHash.length === 0) {
      if (compileMetadataMtimeMs === undefined) {
        return baseKey;
      }

      return `${baseKey}:mtime-${formatMtimeMsForCacheKey(compileMetadataMtimeMs)}`;
    }

    if (compileMetadataMtimeMs === undefined) {
      return `${baseKey}:${sourceGraphHash}`;
    }

    return `${baseKey}:${sourceGraphHash}:mtime-${formatMtimeMsForCacheKey(compileMetadataMtimeMs)}`;
  } catch {
    if (compileMetadataMtimeMs === undefined) {
      return baseKey;
    }

    return `${baseKey}:mtime-${formatMtimeMsForCacheKey(compileMetadataMtimeMs)}`;
  }
}

async function resolveCompileMetadataMtimeMs(
  source: RuntimeCompiledArtifactsSource,
): Promise<number | undefined> {
  if (source.kind !== "disk") {
    return undefined;
  }

  const { stat } = await import("node:fs/promises");
  const { compileMetadataPath } = resolveRuntimeCompilerArtifactPaths(source.appRoot);

  try {
    return (await stat(compileMetadataPath)).mtimeMs;
  } catch {
    return undefined;
  }
}

function formatMtimeMsForCacheKey(value: number): string {
  return Math.floor(value).toString(36);
}
