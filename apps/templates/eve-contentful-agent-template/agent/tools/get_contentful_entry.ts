import { defineTool } from "eve/tools";
import { z } from "zod";

import { getEntry } from "../lib/contentful/entries";
import { withLocale } from "../lib/contentful/tool-locale";

/**
 * Reads an entry addressed by a Contentful editor link or configured public website route.
 *
 * @remarks Localized fields are flattened for model consumption; linked bodies and truncated text require further reads.
 */
export default defineTool({
  description:
    "Fetch a Contentful entry from its web-app URL or a configured public website URL. Read the entry before answering questions about or summarizing its content. " +
    "Returns content type, version, status, fields, and a Contentful link. Rich text is rendered as plain text; linked entries/assets resolve to titles, not their bodies. Use read_contentful_content when content is truncated.",
  execute: withLocale(
    async ({ url }, ctx) => await getEntry(url, ctx.abortSignal)
  ),
  inputSchema: z.object({
    url: z
      .url()
      .describe(
        "The Contentful or configured public website URL exactly as it appeared in the message."
      ),
  }),
});
