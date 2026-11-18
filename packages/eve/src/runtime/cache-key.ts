import {
  getRuntimeCompiledArtifactsCacheKey,
  type RuntimeCompiledArtifactsSource,
} from "#runtime/compiled-artifacts-source.js";
import { resolveRuntimeCompilerArtifactPaths } from "#runtime/loaders/artifact-paths.js";
import {
  type BundledCompiledArtifacts,
  readBundledCompiledArtifacts,
} from "#runtime/loaders/bundled-artifacts.js";
import { loadCompileMetadata } from "#runtime/loaders/compile-metadata.js";

const bundledKeys = new WeakMap<BundledCompiledArtifacts, string>();
const diskKeys = new Map<string, { readonly key: string; readonly mtimeMs: number }>();

export async function resolveRuntimeCompiledArtifactsVersionedCacheKey(
  source: RuntimeCompiledArtifactsSource,
): Promise<string> {
  const baseKey = getRuntimeCompiledArtifactsCacheKey(source);

  if (source.kind !== "disk") {
    const artifacts = readBundledCompiledArtifacts();
    if (artifacts === null) return baseKey;
    const known = bundledKeys.get(artifacts);
    if (known !== undefined) return known;
    const key = await resolveVersionedKey(source, baseKey, undefined);
    bundledKeys.set(artifacts, key);
    return key;
  }

  const mtimeMs = await resolveCompileMetadataMtimeMs(source);
  if (mtimeMs === undefined) return await resolveVersionedKey(source, baseKey, undefined);
  const known = diskKeys.get(baseKey);
  if (known?.mtimeMs === mtimeMs) return known.key;
  const key = await resolveVersionedKey(source, baseKey, mtimeMs);
  diskKeys.set(baseKey, { key, mtimeMs });
  return key;
}

async function resolveVersionedKey(
  source: RuntimeCompiledArtifactsSource,
  baseKey: string,
  compileMetadataMtimeMs: number | undefined,
): Promise<string> {
  const mtimeSuffix =
    compileMetadataMtimeMs === undefined
      ? ""
      : `:mtime-${formatMtimeMsForCacheKey(compileMetadataMtimeMs)}`;

  try {
    const metadata = await loadCompileMetadata({
      compiledArtifactsSource: source,
    });
    const sourceGraphHash = metadata?.discovery.sourceGraphHash;

    return sourceGraphHash === undefined || sourceGraphHash.length === 0
      ? `${baseKey}${mtimeSuffix}`
      : `${baseKey}:${sourceGraphHash}${mtimeSuffix}`;
  } catch {
    return `${baseKey}${mtimeSuffix}`;
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
