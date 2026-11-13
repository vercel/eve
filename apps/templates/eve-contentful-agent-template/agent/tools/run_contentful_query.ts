import { defineTool } from "eve/tools";

import { contentfulQueryInputSchema } from "../lib/contentful/input-schemas";
import { runContentfulQuery } from "../lib/contentful/query";
import { withLocale } from "../lib/contentful/tool-locale";

/**
 * Runs bounded read-only CMA queries with explicit pagination and reference coverage.
 *
 * @remarks The contentful_api skill explains native filters and when incomplete results cannot support absence claims.
 */
export default defineTool({
  description:
    "Run flexible, read-only queries across Contentful entries using filters, keyword search, sorting, and field selection. " +
    "Load contentful_api before use for known models, query rules, and result interpretation. Reuse schemas already in context. " +
    "Returns current Contentful edits, which may differ from live content; check pagination, truncation, and reference coverage before claiming completeness.",
  /**
   * Executes the tool in the calling session.
   *
   * @param input - Validated space, CMA query parameters, and result projection settings.
   * @param ctx - Authenticated tool context carrying cancellation and session identity.
   * @returns Current entry data with pagination, truncation, and reference coverage metadata.
   */
  execute: withLocale(
    async (input, ctx) => await runContentfulQuery(input, ctx.abortSignal)
  ),
  inputSchema: contentfulQueryInputSchema,
});
