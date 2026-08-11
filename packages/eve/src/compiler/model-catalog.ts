import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "#compiled/zod/index.js";
import { AI_GATEWAY_MODELS_CATALOG_URL, vercelGatewayFetch } from "#internal/gateway.js";
import {
  catalogModelSchema,
  findCatalogModelByProviderModelId,
  findCatalogModelBySlug,
  modelCatalogLimitsFromProvider,
  modelCatalogResponseSchema,
  normalizeCatalogModelId,
  type CatalogModel,
} from "#internal/model-catalog.js";
const COMPILED_RUNTIME_MODEL_CATALOG_CACHE_KIND = "eve-model-catalog-cache";
const COMPILED_RUNTIME_MODEL_CATALOG_CACHE_VERSION = 2;
const COMPILED_RUNTIME_MODEL_CATALOG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export {
  catalogModelProviderSchema,
  catalogModelSchema,
  modelCatalogResponseSchema,
} from "#internal/model-catalog.js";
export type { CatalogModelProvider, CatalogModel } from "#internal/model-catalog.js";

/**
 * Stable runtime model limits that eve can embed in compiled artifacts without
 * resolving provider metadata at runtime.
 */
export type CompiledRuntimeModelLimits = z.infer<typeof compiledRuntimeModelLimitsSchema>;

const compiledRuntimeModelLimitsSchema = z
  .object({
    contextWindowTokens: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive().optional(),
  })
  .strict();

const compiledRuntimeModelCatalogCacheSchema = z
  .object({
    fetchedAt: z.string(),
    kind: z.literal(COMPILED_RUNTIME_MODEL_CATALOG_CACHE_KIND),
    models: z.array(catalogModelSchema),
    providerAliases: z.record(z.string(), z.string()),
    version: z.literal(COMPILED_RUNTIME_MODEL_CATALOG_CACHE_VERSION),
  })
  .strict();

const builtInCompiledRuntimeModelLimitsById = new Map<string, CompiledRuntimeModelLimits>([
  [
    "anthropic/claude-opus-4.7",
    {
      contextWindowTokens: 200_000,
      maxOutputTokens: 32_000,
    },
  ],
  [
    "openai/gpt-5.4",
    {
      contextWindowTokens: 400_000,
      maxOutputTokens: 128_000,
    },
  ],
  [
    "openai/gpt-5.4-mini",
    {
      contextWindowTokens: 400_000,
      maxOutputTokens: 128_000,
    },
  ],
]);

/**
 * Loader that resolves compile-time model limits for one application build.
 */
export interface CompiledRuntimeModelCatalogLoader {
  getModelLimits(modelId: string): Promise<CompiledRuntimeModelLimits | null>;
  getByProviderModelId(
    provider: string,
    providerModelId: string,
  ): Promise<{ slug: string; limits: CompiledRuntimeModelLimits } | null>;
}

/**
 * Resolves the app-local cache path used for AI Gateway model metadata during
 * compilation.
 */
export function resolveCompiledRuntimeModelCatalogCachePath(appRoot: string): string {
  return join(appRoot, ".eve", "cache", "model-catalog.json");
}

/**
 * Creates a per-build loader that caches the AI Gateway model catalog in
 * memory and on disk.
 */
export function createCompiledRuntimeModelCatalogLoader(
  appRoot: string,
): CompiledRuntimeModelCatalogLoader {
  let cachedCatalogPromise: Promise<CompiledRuntimeModelCatalogCache | null> | null = null;
  let fetchedCatalogError: unknown = null;
  let fetchedCatalogPromise: Promise<CompiledRuntimeModelCatalogCache> | null = null;

  const getCachedCatalog = async (): Promise<CompiledRuntimeModelCatalogCache | null> => {
    cachedCatalogPromise ??= readModelCatalogCache(appRoot);
    return await cachedCatalogPromise;
  };

  const getFetchedCatalog = async (): Promise<CompiledRuntimeModelCatalogCache> => {
    if (fetchedCatalogError !== null) {
      throw fetchedCatalogError;
    }

    if (fetchedCatalogPromise !== null) {
      return await fetchedCatalogPromise;
    }

    fetchedCatalogPromise = fetchAndPersistModelCatalog(appRoot).then((catalog) => {
      cachedCatalogPromise = Promise.resolve(catalog);
      return catalog;
    });

    try {
      return await fetchedCatalogPromise;
    } catch (error) {
      fetchedCatalogError = error;
      throw error;
    }
  };

  const resolveModelsFromCacheOrFetch = async (): Promise<{
    models: readonly CatalogModel[];
    providerAliases: Readonly<Record<string, string>>;
  } | null> => {
    const cachedCatalog = await getCachedCatalog();

    if (cachedCatalog !== null && isCacheFresh(cachedCatalog)) {
      return cachedCatalog;
    }

    try {
      return await getFetchedCatalog();
    } catch {
      if (cachedCatalog !== null) {
        return cachedCatalog;
      }
      return null;
    }
  };

  return {
    async getModelLimits(modelId) {
      const normalizedId = normalizeCatalogModelId(modelId);
      const resolved = await resolveModelsFromCacheOrFetch();

      if (resolved !== null) {
        const model = findCatalogModelBySlug(resolved.models, normalizedId);
        if (model) {
          for (const p of model.providers) {
            const limits = modelCatalogLimitsFromProvider(p);
            if (limits !== null) {
              return limits;
            }
          }
        }
      }

      return builtInCompiledRuntimeModelLimitsById.get(normalizedId) ?? null;
    },

    async getByProviderModelId(provider, providerModelId) {
      const resolved = await resolveModelsFromCacheOrFetch();
      if (resolved === null) {
        return null;
      }

      const match = findCatalogModelByProviderModelId({
        models: resolved.models,
        provider,
        providerAliases: resolved.providerAliases,
        providerModelId,
      });
      if (match !== null) {
        const limits = modelCatalogLimitsFromProvider(match.provider);
        if (limits !== null) {
          return { slug: match.model.slug, limits };
        }
      }

      return null;
    },
  };
}

type CompiledRuntimeModelCatalogCache = z.infer<typeof compiledRuntimeModelCatalogCacheSchema>;

async function fetchAndPersistModelCatalog(
  appRoot: string,
): Promise<CompiledRuntimeModelCatalogCache> {
  const response = await vercelGatewayFetch(AI_GATEWAY_MODELS_CATALOG_URL);

  if (!response.ok) {
    throw new Error(
      `AI Gateway model catalog request failed with HTTP ${response.status} ${response.statusText}.`,
    );
  }

  const parsed = modelCatalogResponseSchema.safeParse(await response.json());

  if (!parsed.success) {
    throw new Error("AI Gateway model catalog response did not match the expected schema.");
  }

  const cacheArtifact: CompiledRuntimeModelCatalogCache = {
    fetchedAt: new Date().toISOString(),
    kind: COMPILED_RUNTIME_MODEL_CATALOG_CACHE_KIND,
    models: parsed.data.models,
    providerAliases: parsed.data.providerAliases,
    version: COMPILED_RUNTIME_MODEL_CATALOG_CACHE_VERSION,
  };

  try {
    const cachePath = resolveCompiledRuntimeModelCatalogCachePath(appRoot);
    await mkdir(join(appRoot, ".eve", "cache"), { recursive: true });
    await writeFile(cachePath, `${JSON.stringify(cacheArtifact, null, 2)}\n`, "utf8");
  } catch {
    // Cache persistence is best-effort; the fetched data is still usable.
  }

  return cacheArtifact;
}

async function readModelCatalogCache(
  appRoot: string,
): Promise<CompiledRuntimeModelCatalogCache | null> {
  try {
    const cacheText = await readFile(resolveCompiledRuntimeModelCatalogCachePath(appRoot), "utf8");
    const parsed = compiledRuntimeModelCatalogCacheSchema.safeParse(JSON.parse(cacheText));
    return parsed.success ? parsed.data : null;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string" &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    return null;
  }
}

function isCacheFresh(cache: CompiledRuntimeModelCatalogCache): boolean {
  const fetchedAt = Date.parse(cache.fetchedAt);
  if (!Number.isFinite(fetchedAt)) {
    return false;
  }
  return Date.now() - fetchedAt <= COMPILED_RUNTIME_MODEL_CATALOG_CACHE_TTL_MS;
}
