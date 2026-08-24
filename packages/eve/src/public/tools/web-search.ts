import type { WebSearchProvider } from "#shared/web-search.js";

export type { WebSearchProvider };

const WEB_SEARCH_TOOL_KIND = "eve:web-search-tool";

/** Configuration accepted by {@link webSearch}. */
export interface WebSearchToolInput {
  /** Provider to use when the agent model is routed through AI Gateway. */
  readonly provider: WebSearchProvider;
}

/**
 * Provider-managed web search configuration.
 *
 * Export this from `agent/tools/web_search.ts` to select the AI Gateway
 * search provider for that agent. Direct provider models continue to use
 * their native web search implementation.
 */
export interface WebSearchToolDefinition {
  readonly kind: typeof WEB_SEARCH_TOOL_KIND;
  readonly provider: WebSearchProvider;
}

/**
 * Configures eve's `web_search` primitive.
 *
 * When no configuration file is present, eve uses Exa for AI Gateway
 * models.
 *
 * @example
 * ```ts
 * // agent/tools/web_search.ts
 * import { webSearch } from "eve/tools";
 *
 * export default webSearch({ provider: "parallel" });
 * ```
 */
export function webSearch(input: WebSearchToolInput): WebSearchToolDefinition {
  return {
    kind: WEB_SEARCH_TOOL_KIND,
    provider: input.provider,
  };
}

/** eve's canonical default web-search provider selection. */
export const defaultWebSearch = webSearch({ provider: "exa" });

/** Returns whether a value is a provider-managed web search definition. */
export function isWebSearchToolDefinition(value: unknown): value is WebSearchToolDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === WEB_SEARCH_TOOL_KIND
  );
}
