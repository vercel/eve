import { markHarnessOwnedToolDefinition } from "#shared/harness-owned-tool.js";
import type { WebSearchProvider } from "#shared/web-search.js";

export type { WebSearchProvider };

const WEB_SEARCH_TOOL_KIND = "eve:web-search-tool";

/**
 * Model-facing description of the framework `web_search` tool.
 */
export const WEB_SEARCH_TOOL_DESCRIPTION =
  "Search the web for real-time information. Use this to find up-to-date information about current events, recent developments, or topics that may have changed since the knowledge cutoff.";

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
  readonly provider?: WebSearchProvider;
}

/**
 * Configures the framework-provided `web_search` tool.
 *
 * Call with no argument to keep the environment default: eve uses Exa for
 * AI Gateway models when no provider is selected.
 *
 * @example
 * ```ts
 * // agent/tools/web_search.ts
 * import { webSearch } from "eve/tools";
 *
 * export default webSearch({ provider: "parallel" });
 * ```
 */
export function webSearch(input?: WebSearchToolInput): WebSearchToolDefinition {
  // The sentinel is harness-owned: the provider-managed tool materializes at
  // eligible model calls, so the compiled definition resolves without a
  // module executor.
  if (input === undefined) {
    return markHarnessOwnedToolDefinition({ kind: WEB_SEARCH_TOOL_KIND });
  }
  return markHarnessOwnedToolDefinition({
    kind: WEB_SEARCH_TOOL_KIND,
    provider: input.provider,
  });
}

/** Returns whether a value is a provider-managed web search definition. */
export function isWebSearchToolDefinition(value: unknown): value is WebSearchToolDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === WEB_SEARCH_TOOL_KIND
  );
}
