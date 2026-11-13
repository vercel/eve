import { defineTool } from "eve/tools";
import { z } from "zod";

import { readEntryContent } from "../lib/contentful/entries";
import { withLocale } from "../lib/contentful/tool-locale";

/**
 * Reads paginated Contentful text and optionally the raw blocks needed for targeted rich-text patches.
 *
 * @remarks Cursors bind entry identity, version, mode, and position; changed entries require restarting the read.
 */
export default defineTool({
  description:
    "Read Contentful text fields in pages of up to 12,000 characters when get_contentful_entry is truncated or detailed evidence is needed. " +
    "Returns JSON-pointer field locations, character offsets, current version/status, and direct links to referenced entries. " +
    "Each top-level RichText block is a separate section with its block index and hash, which RichText patches in update_contentful_fields use to address it. " +
    "Pass nextCursor unchanged for another page. A version change requires discarding earlier pages and restarting. " +
    "Embedded entry bodies are separate: fetch their Contentful links explicitly. This reads current Contentful fields, not the public website.",
  execute: withLocale(
    async ({ url, cursor, richTextJson }, ctx) =>
      await readEntryContent(url, cursor, ctx.abortSignal, {
        richTextJson: richTextJson === true,
      })
  ),
  inputSchema: z.object({
    cursor: z
      .string()
      .max(2048)
      .nullable()
      .describe(
        "The previous result's nextCursor, unchanged. Null starts a fresh read."
      ),
    richTextJson: z
      .boolean()
      .nullable()
      .describe(
        "True also returns each top-level RichText block's raw JSON, unsplit, for building replaceBlocks patches. Null or false returns text only. Keep the same value when passing a cursor."
      ),
    url: z
      .url()
      .describe("Contentful entry URL or configured public page URL to read."),
  }),
});
