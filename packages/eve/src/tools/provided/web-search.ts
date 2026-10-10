import type { WebSearchFallbackProvider, WebSearchProvider } from "#shared/web-search.js";
import { frameworkTool } from "./framework-tool.js";

export type { WebSearchFallbackProvider, WebSearchProvider };

const WEB_SEARCH_TOOL_KIND = "eve:web-search-tool";

/**
 * Configuration accepted by {@link webSearch}: the provider to use when the agent model is routed
 * through AI Gateway.
 */
export type WebSearchToolInput =
  | {
      /**
       * The model vendor's own hosted search: OpenAI's for OpenAI models, Anthropic's for Claude,
       * and Google Search grounding for Gemini 3 and later.
       */
      readonly provider: "native";
      /** Provider for Gateway models without native search. Without it, they don't get `web_search`. */
      readonly fallback?: WebSearchFallbackProvider;
    }
  | {
      /** A search provider that AI Gateway runs for any Gateway model. */
      readonly provider: WebSearchFallbackProvider;
      readonly fallback?: never;
    };

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
  readonly fallback?: WebSearchFallbackProvider;
}

/**
 * Configures the framework-provided `web_search` tool.
 *
 * When no configuration file is present, eve uses Exa for AI Gateway
 * models.
 *
 * @example
 * ```ts
 * // agent/tools/web_search.ts
 * import { webSearch } from "eve/tools/web_search";
 *
 * export default webSearch({ provider: "parallel" });
 * ```
 */
export function webSearch(input: WebSearchToolInput): WebSearchToolDefinition {
  return frameworkTool({
    kind: WEB_SEARCH_TOOL_KIND,
    provider: input.provider,
    ...(input.fallback !== undefined && { fallback: input.fallback }),
  });
}

/** Default provider-managed web search configuration. */
export const defaultWebSearch = webSearch({ provider: "exa" });

export default defaultWebSearch;

/** Returns whether a value is a provider-managed web search definition. */
export function isWebSearchToolDefinition(value: unknown): value is WebSearchToolDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === WEB_SEARCH_TOOL_KIND
  );
}
