import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "#compiled/zod/index.js";
import { AI_GATEWAY_MODELS_CATALOG_URL, vercelGatewayFetch } from "#internal/gateway.js";
import {
  catalogModelSchema,
  createModelMetadata,
  lookupCatalogModelByProviderModelId,
  lookupCatalogModelBySlug,
  modelCatalogResponseSchema,
  type ModelCatalog,
  type ModelCatalogEntry,
  type ModelMetadata,
} from "#internal/model-catalog.js";

const MODEL_CATALOG_CACHE_KIND = "eve-model-catalog-cache";
const MODEL_CATALOG_CACHE_VERSION = 2;
const MODEL_CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;
const MODEL_CATALOG_FETCH_TIMEOUT_MS = 15_000;
const MODEL_CATALOG_RETRY_DELAYS_MS = [250, 500];
const MODEL_CATALOG_RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

const modelCatalogCacheSchema = z
  .object({
    fetchedAt: z.string(),
    kind: z.literal(MODEL_CATALOG_CACHE_KIND),
    models: z.array(catalogModelSchema),
    providerAliases: z.record(z.string(), z.string()),
    version: z.literal(MODEL_CATALOG_CACHE_VERSION),
  })
  .strict();

type ModelCatalogCache = z.infer<typeof modelCatalogCacheSchema>;

export interface CompiledRuntimeModelCatalogLoader {
  getModelLimits(modelId: string): Promise<ModelCatalogEntry | null>;
  getByProviderModelId(
    provider: string,
    providerModelId: string,
  ): Promise<ModelCatalogEntry | null>;
  loadModelMetadata(): Promise<ModelMetadata>;
}

export function resolveCompiledRuntimeModelCatalogCachePath(appRoot: string): string {
  return join(appRoot, ".eve", "cache", "model-catalog.json");
}

export function createCompiledRuntimeModelCatalogLoader(
  appRoot: string,
): CompiledRuntimeModelCatalogLoader {
  let cachedCatalogPromise: Promise<ModelCatalogCache | null> | null = null;
  let fetchedCatalogError: unknown = null;
  let fetchedCatalogPromise: Promise<ModelCatalogCache> | null = null;

  const getCachedCatalog = async (): Promise<ModelCatalogCache | null> => {
    cachedCatalogPromise ??= readModelCatalogCache(appRoot);
    return await cachedCatalogPromise;
  };

  const getFetchedCatalog = async (): Promise<ModelCatalogCache> => {
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

  const resolveCatalog = async (options?: {
    forceRefresh?: boolean;
  }): Promise<ModelCatalogCache> => {
    const cachedCatalog = await getCachedCatalog();

    if (options?.forceRefresh !== true && cachedCatalog !== null && isCacheFresh(cachedCatalog)) {
      return cachedCatalog;
    }

    try {
      return await getFetchedCatalog();
    } catch (error) {
      if (cachedCatalog !== null) {
        return cachedCatalog;
      }
      throw error;
    }
  };

  const lookup = async (
    find: (catalog: ModelCatalog) => ModelCatalogEntry | null,
  ): Promise<ModelCatalogEntry | null> =>
    find(await resolveCatalog()) ?? find(await resolveCatalog({ forceRefresh: true }));

  return {
    getModelLimits: async (modelId) =>
      await lookup((catalog) => lookupCatalogModelBySlug(catalog, modelId)),

    getByProviderModelId: async (provider, providerModelId) =>
      await lookup((catalog) =>
        lookupCatalogModelByProviderModelId(catalog, provider, providerModelId),
      ),

    async loadModelMetadata() {
      try {
        const catalog = await resolveCatalog();
        return createModelMetadata({ catalog, fetchedAt: catalog.fetchedAt });
      } catch {
        return createModelMetadata(null);
      }
    },
  };
}

async function fetchModelCatalog(): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    let retryableStatus = false;
    try {
      const response = await vercelGatewayFetch(AI_GATEWAY_MODELS_CATALOG_URL, {
        signal: AbortSignal.timeout(MODEL_CATALOG_FETCH_TIMEOUT_MS),
      });
      if (response.ok) return await response.json();
      retryableStatus = MODEL_CATALOG_RETRY_STATUSES.has(response.status);
      await response.body?.cancel().catch(() => {});
      throw new Error(
        `AI Gateway model catalog request failed with HTTP ${response.status} ${response.statusText}.`,
      );
    } catch (error) {
      const delayMs = MODEL_CATALOG_RETRY_DELAYS_MS[attempt];
      const transient =
        retryableStatus ||
        (error instanceof Error && error.name === "TimeoutError") ||
        (error instanceof TypeError &&
          (error.message === "fetch failed" || error.message === "terminated"));
      if (delayMs === undefined || !transient) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function fetchAndPersistModelCatalog(appRoot: string): Promise<ModelCatalogCache> {
  const parsed = modelCatalogResponseSchema.safeParse(await fetchModelCatalog());

  if (!parsed.success) {
    throw new Error("AI Gateway model catalog response did not match the expected schema.");
  }

  const cacheArtifact: ModelCatalogCache = {
    fetchedAt: new Date().toISOString(),
    kind: MODEL_CATALOG_CACHE_KIND,
    models: parsed.data.models,
    providerAliases: parsed.data.providerAliases,
    version: MODEL_CATALOG_CACHE_VERSION,
  };

  try {
    const cachePath = resolveCompiledRuntimeModelCatalogCachePath(appRoot);
    await mkdir(join(appRoot, ".eve", "cache"), { recursive: true });
    await writeFile(cachePath, `${JSON.stringify(cacheArtifact, null, 2)}\n`, "utf8");
  } catch {}

  return cacheArtifact;
}

async function readModelCatalogCache(appRoot: string): Promise<ModelCatalogCache | null> {
  try {
    const cacheText = await readFile(resolveCompiledRuntimeModelCatalogCachePath(appRoot), "utf8");
    const parsed = modelCatalogCacheSchema.safeParse(JSON.parse(cacheText));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function isCacheFresh(cache: ModelCatalogCache): boolean {
  const fetchedAt = Date.parse(cache.fetchedAt);
  if (!Number.isFinite(fetchedAt)) {
    return false;
  }
  return Date.now() - fetchedAt <= MODEL_CATALOG_CACHE_TTL_MS;
}
