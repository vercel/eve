import {
  getRuntimeCompiledArtifactsCacheKey,
  type RuntimeCompiledArtifactsSource,
} from "#runtime/compiled-artifacts-source.js";
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
  const metadata = await loadCompileMetadata({ compiledArtifactsSource: source });
  return `${baseKey}:${metadata.discovery.sourceGraphHash}`;
}
