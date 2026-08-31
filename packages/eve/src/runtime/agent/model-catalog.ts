import {
  AI_GATEWAY_MODELS_CATALOG_URL,
  AI_GATEWAY_MODELS_URL,
  vercelGatewayFetch,
} from "#internal/gateway.js";
import {
  findCatalogModelByProviderModelId,
  findCatalogModelBySlug,
  gatewayModelListResponseSchema,
  modelCostEstimatesFromGatewayModelList,
  modelCatalogLimitsFromProvider,
  modelCatalogResponseSchema,
} from "#internal/model-catalog.js";
import type { ModelCostEstimate } from "#shared/model-cost.js";

export interface RuntimeModelMetadata {
  readonly costEstimate?: ModelCostEstimate;
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
        .then(async (catalogResponse) => {
          if (!catalogResponse.ok) {
            throw new Error(
              `AI Gateway model catalog request failed with HTTP ${catalogResponse.status} ${catalogResponse.statusText}.`,
            );
          }
          const modelListResponse = await Promise.resolve(
            fetchCatalog(AI_GATEWAY_MODELS_URL),
          ).catch(() => undefined);
          return parseCatalogResponse(
            await catalogResponse.json(),
            modelListResponse?.ok ? await modelListResponse.json() : undefined,
          );
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
          return {
            ...limits,
            costEstimate: catalog.modelCostEstimates[model.slug],
            resolvedModelId: model.slug,
          };
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
      return limits === null
        ? null
        : {
            ...limits,
            costEstimate: catalog.modelCostEstimates[match.model.slug],
            resolvedModelId: match.model.slug,
          };
    },
  };
}

function parseCatalogResponse(catalogValue: unknown, modelListValue: unknown) {
  const parsed = modelCatalogResponseSchema.safeParse(catalogValue);
  if (!parsed.success) {
    throw new Error("AI Gateway model catalog response did not match the expected schema.");
  }
  const modelList = gatewayModelListResponseSchema.safeParse(modelListValue);
  return {
    ...parsed.data,
    modelCostEstimates: modelList.success
      ? modelCostEstimatesFromGatewayModelList(modelList.data.data)
      : {},
  };
}
