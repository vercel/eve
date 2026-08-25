import { webSearch } from "#public/tools/web-search.js";

/**
 * Framework default `web_search` configuration: the provider-managed web
 * search sentinel with no provider selected, so the runtime picks the
 * environment default (Exa for AI Gateway models).
 */
export default webSearch();
