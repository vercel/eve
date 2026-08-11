import { AI_GATEWAY_MODELS_CATALOG_URL, vercelGatewayFetch } from "#internal/gateway.js";
import {
  findCatalogModelByProviderModelId,
  findCatalogModelBySlug,
  modelCatalogLimitsFromProvider,
  modelCatalogResponseSchema,
} from "#internal/model-catalog.js";

export interface RuntimeModelMetadata {
  readonly contextWindowTokens: number;
  readonly maxOutputTokens?: number;
  readonly resolvedModelId: string;
}

export interface RuntimeModelCatalog {
  getByGatewayId(modelId: string): Promise<RuntimeModelMetadata | null>;
  getByProviderModelId(
    provider: string,
    providerModelId: string,
  ): Promise<RuntimeModelMetadata | null>;
}

export function createRuntimeModelCatalog(
  fetchCatalog: typeof globalThis.fetch = vercelGatewayFetch,
): RuntimeModelCatalog {
  let catalogPromise: Promise<ReturnType<typeof parseCatalogResponse>> | null = null;

  const loadCatalog = async () => {
    if (catalogPromise === null) {
      catalogPromise = fetchCatalog(AI_GATEWAY_MODELS_CATALOG_URL)
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(
              `AI Gateway model catalog request failed with HTTP ${response.status} ${response.statusText}.`,
            );
          }
          return parseCatalogResponse(await response.json());
        })
        .catch((error: unknown) => {
          catalogPromise = null;
          throw error;
        });
    }
    return await catalogPromise;
  };

  return {
    async getByGatewayId(modelId) {
      const catalog = await loadCatalog();
      const model = findCatalogModelBySlug(catalog.models, modelId);
      if (model === undefined) return null;

      for (const provider of model.providers) {
        const limits = modelCatalogLimitsFromProvider(provider);
        if (limits !== null) {
          return { ...limits, resolvedModelId: model.slug };
        }
      }
      return null;
    },

    async getByProviderModelId(provider, providerModelId) {
      const catalog = await loadCatalog();
      const match = findCatalogModelByProviderModelId({
        models: catalog.models,
        provider,
        providerAliases: catalog.providerAliases,
        providerModelId,
      });
      if (match === null) return null;
      const limits = modelCatalogLimitsFromProvider(match.provider);
      return limits === null ? null : { ...limits, resolvedModelId: match.model.slug };
    },
  };
}

function parseCatalogResponse(value: unknown) {
  const parsed = modelCatalogResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("AI Gateway model catalog response did not match the expected schema.");
  }
  return parsed.data;
}
