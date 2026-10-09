/** Web search providers that AI Gateway runs for any Gateway model. */
export const WEB_SEARCH_FALLBACK_PROVIDERS = ["exa", "parallel", "browserbase"] as const;

/**
 * Web search providers available through Vercel AI Gateway. `openai` is OpenAI's hosted search,
 * which serves only OpenAI models.
 */
export const WEB_SEARCH_PROVIDERS = [...WEB_SEARCH_FALLBACK_PROVIDERS, "openai"] as const;

export type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number];

export type WebSearchFallbackProvider = (typeof WEB_SEARCH_FALLBACK_PROVIDERS)[number];

/** The Gateway search an agent selected, and what a model the provider can't serve uses instead. */
export interface WebSearchSelection {
  readonly provider: WebSearchProvider;
  /** Used when `provider` can't serve the model; without it, that model gets no `web_search`. */
  readonly fallback?: WebSearchFallbackProvider;
}
