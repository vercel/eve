import { z } from "#compiled/zod/index.js";
import type { ModelCostEstimate } from "#shared/model-cost.js";

const THINKING_SUFFIX = "-thinking";

export const catalogModelProviderSchema = z
  .object({
    provider: z.string().min(1),
    providerModelId: z.string().min(1),
    contextWindowTokens: z.number().int().nonnegative().optional(),
    maxOutputTokens: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export const catalogModelSchema = z
  .object({
    slug: z.string().min(1),
    providers: z.array(catalogModelProviderSchema).min(1),
  })
  .passthrough();

export const modelCatalogResponseSchema = z
  .object({
    models: z.array(catalogModelSchema),
    providerAliases: z.record(z.string(), z.string()),
  })
  .passthrough();

const gatewayModelListEntrySchema = z
  .object({
    id: z.string().min(1),
    pricing: z.unknown().optional(),
  })
  .passthrough();

export const gatewayModelListResponseSchema = z
  .object({ data: z.array(gatewayModelListEntrySchema) })
  .passthrough();

export type CatalogModelProvider = z.infer<typeof catalogModelProviderSchema>;
export type CatalogModel = z.infer<typeof catalogModelSchema>;
export type GatewayModelListEntry = z.infer<typeof gatewayModelListEntrySchema>;

export interface ModelCatalogLimits {
  readonly contextWindowTokens: number;
  readonly maxOutputTokens?: number;
}

/** Parses the base per-token rates from the public AI Gateway model listing. */
export function modelCostEstimateFromGatewayModel(
  model: GatewayModelListEntry,
): ModelCostEstimate | undefined {
  if (!isRecord(model.pricing)) return undefined;
  const inputUsdPerToken = readUsd(model.pricing.input);
  const outputUsdPerToken = readUsd(model.pricing.output);
  if (inputUsdPerToken === undefined || outputUsdPerToken === undefined) return undefined;

  const cacheReadUsdPerToken = readUsd(model.pricing.input_cache_read);
  const cacheWriteUsdPerToken = readUsd(model.pricing.input_cache_write);
  return {
    inputUsdPerToken,
    outputUsdPerToken,
    ...(cacheReadUsdPerToken !== undefined && { cacheReadUsdPerToken }),
    ...(cacheWriteUsdPerToken !== undefined && { cacheWriteUsdPerToken }),
  };
}

export function modelCostEstimatesFromGatewayModelList(
  models: readonly GatewayModelListEntry[],
): Readonly<Record<string, ModelCostEstimate>> {
  const estimates: Record<string, ModelCostEstimate> = {};
  for (const model of models) {
    const estimate = modelCostEstimateFromGatewayModel(model);
    if (estimate !== undefined) estimates[model.id] = estimate;
  }
  return estimates;
}

function readUsd(value: unknown): number | undefined {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeCatalogModelId(modelId: string): string {
  return modelId.endsWith(THINKING_SUFFIX) ? modelId.slice(0, -THINKING_SUFFIX.length) : modelId;
}

export function findCatalogModelBySlug(
  models: readonly CatalogModel[],
  slug: string,
): CatalogModel | undefined {
  // Some models publish `-thinking` as their own canonical slug, so the
  // verbatim id must win before the suffix is stripped.
  const exact = models.find((model) => model.slug === slug);
  if (exact !== undefined) {
    return exact;
  }

  const normalized = normalizeCatalogModelId(slug);
  return normalized === slug ? undefined : models.find((model) => model.slug === normalized);
}

export function findCatalogModelByProviderModelId(input: {
  readonly models: readonly CatalogModel[];
  readonly provider: string;
  readonly providerAliases: Readonly<Record<string, string>>;
  readonly providerModelId: string;
}): { readonly model: CatalogModel; readonly provider: CatalogModelProvider } | null {
  const baseProvider = input.provider.split(".")[0]!;
  const resolvedProvider = input.providerAliases[baseProvider] ?? baseProvider;
  const normalizedModelId = normalizeCatalogModelId(input.providerModelId);

  for (const model of input.models) {
    for (const provider of model.providers) {
      if (
        provider.provider === resolvedProvider &&
        normalizeCatalogModelId(provider.providerModelId) === normalizedModelId
      ) {
        return { model, provider };
      }
    }
  }

  return null;
}

export function modelCatalogLimitsFromProvider(
  provider: CatalogModelProvider,
): ModelCatalogLimits | null {
  if (provider.contextWindowTokens === undefined || provider.contextWindowTokens <= 0) {
    return null;
  }
  return {
    contextWindowTokens: provider.contextWindowTokens,
    ...(provider.maxOutputTokens !== undefined &&
      provider.maxOutputTokens > 0 && { maxOutputTokens: provider.maxOutputTokens }),
  };
}
