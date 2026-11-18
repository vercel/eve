/** Web search providers that AI Gateway runs for any Gateway model. */
export const WEB_SEARCH_FALLBACK_PROVIDERS = ["exa", "parallel", "browserbase", "tako"] as const;

/**
 * Web search providers available through Vercel AI Gateway. `native` is the model vendor's own
 * hosted search, which only some vendors' models have.
 */
export const WEB_SEARCH_PROVIDERS = [...WEB_SEARCH_FALLBACK_PROVIDERS, "native"] as const;

/** A web search provider an agent can select, one of {@link WEB_SEARCH_PROVIDERS}. */
export type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number];

/**
 * A web search provider AI Gateway runs for any model, usable as a fallback; one of
 * {@link WEB_SEARCH_FALLBACK_PROVIDERS}.
 */
export type WebSearchFallbackProvider = (typeof WEB_SEARCH_FALLBACK_PROVIDERS)[number];

/** The Gateway search an agent selected, and what a model the provider can't serve uses instead. */
export interface WebSearchSelection {
  readonly provider: WebSearchProvider;
  /** Used when `provider` can't serve the model; without it, that model gets no `web_search`. */
  readonly fallback?: WebSearchFallbackProvider;
}
