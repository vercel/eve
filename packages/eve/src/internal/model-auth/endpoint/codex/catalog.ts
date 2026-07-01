const OPENAI_GATEWAY_PREFIX = "openai/";
const CODEX_PROVIDER = "codex";

export function parseCodexModelId(modelId: string): string | null {
  const prefix = `${CODEX_PROVIDER}/`;
  if (!modelId.startsWith(prefix)) return null;
  const slug = modelId.slice(prefix.length).trim();
  return slug.length === 0 ? null : slug;
}

export function codexModelSlugFromGatewayId(modelId: string): string | null {
  if (!modelId.startsWith(OPENAI_GATEWAY_PREFIX)) return null;
  const slug = modelId.slice(OPENAI_GATEWAY_PREFIX.length).trim();
  return slug.length === 0 ? null : slug;
}

export function formatOpenAiGatewayModelId(slug: string): string {
  return `${OPENAI_GATEWAY_PREFIX}${slug}`;
}
