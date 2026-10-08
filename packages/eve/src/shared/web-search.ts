/**
 * Web search providers available through Vercel AI Gateway. `openai` is OpenAI's hosted search,
 * which serves only OpenAI models.
 */
export const WEB_SEARCH_PROVIDERS = ["exa", "parallel", "browserbase", "openai"] as const;

export type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number];
