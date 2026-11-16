import { del } from "@vercel/blob";
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { isReservedUrl, RESERVED_PATH_ERROR } from "#lib/reserved-paths.js";

/**
 * Tool that permanently deletes an asset from Vercel Blob storage.
 *
 * @remarks
 * Authorization resolves from the ambient Vercel OIDC credentials; no `BLOB_READ_WRITE_TOKEN`
 * is required. Deletion is irreversible, so this tool is gated on human approval: in Slack
 * it renders as an approve/deny button.
 */
export default defineTool({
  approval: always(),
  description:
    "Permanently delete an asset from Vercel Blob storage by its URL. Use only when the user " +
    "explicitly asks to remove a stored file. This is irreversible.",
  /**
   * Delete the asset.
   *
   * @param input - Validated tool input.
   * @returns `success`/`deleted` flags and the `url`, or `success: false` with an `error`.
   */
  async execute({ url }) {
    if (isReservedUrl(url)) {
      return {
        deleted: false,
        error: RESERVED_PATH_ERROR,
        success: false,
        url,
      };
    }
    try {
      await del(url);
      return { deleted: true, success: true, url };
    } catch (error) {
      return {
        deleted: false,
        error: error instanceof Error ? error.message : "Delete failed",
        success: false,
        url,
      };
    }
  },
  inputSchema: z.object({
    url: z.url().describe("The full Vercel Blob URL of the asset to delete."),
  }),
  outputSchema: z.object({
    deleted: z.boolean(),
    error: z.string().optional(),
    success: z.boolean(),
    url: z.string(),
  }),
});
