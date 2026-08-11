import { z } from "#compiled/zod/index.js";

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

export type CatalogModelProvider = z.infer<typeof catalogModelProviderSchema>;
export type CatalogModel = z.infer<typeof catalogModelSchema>;

export interface ModelCatalogLimits {
  readonly contextWindowTokens: number;
  readonly maxOutputTokens?: number;
}

export function normalizeCatalogModelId(modelId: string): string {
  return modelId.endsWith(THINKING_SUFFIX) ? modelId.slice(0, -THINKING_SUFFIX.length) : modelId;
}

export function findCatalogModelBySlug(
  models: readonly CatalogModel[],
  slug: string,
): CatalogModel | undefined {
  return models.find((model) => model.slug === normalizeCatalogModelId(slug));
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
