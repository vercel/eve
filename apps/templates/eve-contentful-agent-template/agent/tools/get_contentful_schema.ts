import { defineTool } from "eve/tools";

import { contentfulSchemaInputSchema } from "../lib/contentful/input-schemas";
import { getContentfulSchema } from "../lib/contentful/schema";
import { withLocale } from "../lib/contentful/tool-locale";

/**
 * Exposes live Contentful content models and field-level reference constraints.
 *
 * @remarks A null content type returns the paginated catalog; a specified type returns its complete field schema.
 */
export default defineTool({
  description:
    "Discover configured Contentful content types or inspect their fields and allowed references. Use only before creating or editing an entry, after a schema-related API error, or when the search_content script reports that its content isn't available; otherwise answer questions about content models from the search_content skill's schema tables. Reuse known schemas and avoid unrelated discovery. " +
    "Null contentTypeId lists a paginated catalog; an ID returns its full field schema and ignores limit/skip. linkType distinguishes Entry/Asset links; null allowedContentTypeIds means no explicit type restriction. RichText fields include richTextReferences describing allowed same-space embed/hyperlink nodes and target types; other fields return null. " +
    "Schema permissions do not establish actual usage or absence in older entries. Cross-space resource references are not described.",
  /**
   * Executes the tool in the calling session.
   *
   * @param input - Validated space, optional content type, and catalog pagination settings.
   * @param ctx - Authenticated tool context carrying cancellation and session identity.
   * @returns Content type catalog or detailed field definitions and reference constraints.
   */
  execute: withLocale(
    async (input, ctx) => await getContentfulSchema(input, ctx.abortSignal)
  ),
  inputSchema: contentfulSchemaInputSchema,
});
