const CODEX_PROVIDER = "codex";
const OPENAI_GATEWAY_PREFIX = "openai/";

export interface CodexModelCatalogEntry {
  readonly contextWindowTokens?: number;
  readonly displayName: string;
  readonly slug: string;
  readonly visibility?: string;
}

export interface CodexGatewayCatalogModel {
  readonly id: string;
  readonly name?: string;
  readonly type?: string;
}

export function formatCodexModelId(slug: string): string {
  return `${CODEX_PROVIDER}/${slug}`;
}

export function parseCodexModelId(modelId: string): string | null {
  const prefix = `${CODEX_PROVIDER}/`;
  if (!modelId.startsWith(prefix)) return null;
  const slug = modelId.slice(prefix.length).trim();
  return slug.length === 0 ? null : slug;
}

export function isCodexProvider(provider: string): boolean {
  return provider.split(".")[0] === CODEX_PROVIDER;
}

export function codexModelSlugFromGatewayId(modelId: string): string | null {
  if (!modelId.startsWith(OPENAI_GATEWAY_PREFIX)) return null;
  const slug = modelId.slice(OPENAI_GATEWAY_PREFIX.length).trim();
  return slug.length === 0 ? null : slug;
}

export function codexModelsFromGatewayCatalog(
  models: readonly CodexGatewayCatalogModel[],
): readonly CodexModelCatalogEntry[] {
  const bySlug = new Map<string, CodexModelCatalogEntry>();

  for (const model of models) {
    if (model.type !== undefined && model.type !== "language") continue;

    const slug = codexModelSlugFromGatewayId(model.id);
    if (slug === null || bySlug.has(slug)) continue;

    bySlug.set(slug, {
      slug,
      displayName: model.name?.trim() || slug,
    });
  }

  return [...bySlug.values()];
}

export function selectableCodexModels(
  models: readonly CodexModelCatalogEntry[],
): readonly CodexModelCatalogEntry[] {
  const listed = models.filter(
    (model) => model.visibility === undefined || model.visibility === "list",
  );
  return [...listed].sort((a, b) => a.displayName.localeCompare(b.displayName));
}
