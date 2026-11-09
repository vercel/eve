import { z } from "#compiled/zod/index.js";

const THINKING_SUFFIX = "-thinking";
const MODEL_METADATA_KIND = "eve-model-metadata";
const MODEL_METADATA_VERSION = 1;

export const catalogModelProviderSchema = z
  .object({
    provider: z.string().min(1),
    providerModelId: z.string().min(1),
    contextWindowTokens: z.number().int().nonnegative().optional(),
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

/** The parts of the AI Gateway model catalog that eve's lookups read. */
export interface ModelCatalog {
  readonly models: readonly CatalogModel[];
  readonly providerAliases: Readonly<Record<string, string>>;
}

/** A catalog match: the canonical Gateway slug and the context window eve compacts against. */
export interface ModelCatalogEntry {
  readonly contextWindowTokens: number;
  readonly slug: string;
}

/**
 * The model metadata one build bakes into its compiled artifacts. Runtime model selections
 * resolve context windows from this snapshot and never call AI Gateway themselves.
 */
export const modelMetadataSchema = z
  .object({
    /** When the build read the catalog, or `null` when the catalog was unavailable. */
    fetchedAt: z.string().nullable(),
    kind: z.literal(MODEL_METADATA_KIND),
    models: z.array(
      z
        .object({
          slug: z.string().min(1),
          providers: z
            .array(
              z
                .object({
                  contextWindowTokens: z.number().int().positive(),
                  provider: z.string().min(1),
                  providerModelId: z.string().min(1),
                })
                .strict(),
            )
            .min(1),
        })
        .strict(),
    ),
    providerAliases: z.record(z.string(), z.string()),
    version: z.literal(MODEL_METADATA_VERSION),
  })
  .strict();

export type ModelMetadata = z.infer<typeof modelMetadataSchema>;

/**
 * Projects a catalog onto the snapshot a build ships: only providers with a usable context
 * window, and only the fields eve's lookups read.
 */
export function createModelMetadata(
  input: { readonly catalog: ModelCatalog; readonly fetchedAt: string } | null,
): ModelMetadata {
  const models: ModelMetadata["models"] = [];
  for (const model of input?.catalog.models ?? []) {
    const providers = model.providers.flatMap(
      ({ contextWindowTokens, provider, providerModelId }) =>
        contextWindowTokens === undefined || contextWindowTokens <= 0
          ? []
          : [{ contextWindowTokens, provider, providerModelId }],
    );
    if (providers.length > 0) models.push({ slug: model.slug, providers });
  }
  return {
    fetchedAt: input?.fetchedAt ?? null,
    kind: MODEL_METADATA_KIND,
    models,
    providerAliases: { ...input?.catalog.providerAliases },
    version: MODEL_METADATA_VERSION,
  };
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

/** Looks up an AI Gateway model id, such as `anthropic/claude-sonnet-5`. */
export function lookupCatalogModelBySlug(
  catalog: ModelCatalog,
  slug: string,
): ModelCatalogEntry | null {
  const model = findCatalogModelBySlug(catalog.models, slug);
  if (model === undefined) return null;
  for (const provider of model.providers) {
    const contextWindowTokens = contextWindowOf(provider);
    if (contextWindowTokens !== null) return { contextWindowTokens, slug: model.slug };
  }
  return null;
}

/** Looks up an AI SDK provider model, such as `anthropic.messages` and `claude-sonnet-5`. */
export function lookupCatalogModelByProviderModelId(
  catalog: ModelCatalog,
  provider: string,
  providerModelId: string,
): ModelCatalogEntry | null {
  const baseProvider = provider.split(".")[0]!;
  const resolvedProvider = catalog.providerAliases[baseProvider] ?? baseProvider;
  const normalizedModelId = normalizeCatalogModelId(providerModelId);

  for (const model of catalog.models) {
    for (const entry of model.providers) {
      // Skip windowless entries, as the snapshot drops them, so both resolve alike.
      const contextWindowTokens = contextWindowOf(entry);
      if (
        contextWindowTokens !== null &&
        entry.provider === resolvedProvider &&
        normalizeCatalogModelId(entry.providerModelId) === normalizedModelId
      ) {
        return { contextWindowTokens, slug: model.slug };
      }
    }
  }

  return null;
}

function contextWindowOf(provider: CatalogModelProvider): number | null {
  return provider.contextWindowTokens === undefined || provider.contextWindowTokens <= 0
    ? null
    : provider.contextWindowTokens;
}
