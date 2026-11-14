import { list } from "@vercel/blob";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { isReservedPath } from "#lib/reserved-paths.js";

/**
 * Tool that lists assets in Vercel Blob storage, optionally filtered by path prefix.
 *
 * @remarks
 * Authorization resolves from the ambient Vercel OIDC credentials; no `BLOB_READ_WRITE_TOKEN`
 * is required. Use it to browse stored assets or find a specific one before downloading.
 */
export default defineTool({
  description:
    "List assets in Vercel Blob storage, optionally filtered by a path prefix. Returns each " +
    "asset's URL, size, and upload date. When hasMore is true, pass the returned cursor " +
    "with the same prefix to get the next page, even if the current page has no visible assets.",
  /**
   * List matching assets.
   *
   * @param input - Validated tool input.
   * @returns The matching `assets`, their `count`, a `hasMore` flag, and a pagination
   * `cursor`, or an empty list with an `error` message on failure.
   */
  async execute({ prefix, limit, cursor: inputCursor }) {
    try {
      const { blobs, hasMore, cursor } = await list({
        cursor: inputCursor,
        limit,
        prefix,
      });
      const visible = blobs.filter((blob) => !isReservedPath(blob.pathname));
      return {
        assets: visible.map((blob) => ({
          pathname: blob.pathname,
          size: blob.size,
          uploadedAt: blob.uploadedAt.toISOString(),
          url: blob.url,
        })),
        count: visible.length,
        cursor,
        hasMore,
      };
    } catch (error) {
      return {
        assets: [],
        count: 0,
        error: error instanceof Error ? error.message : "Failed to list assets",
        hasMore: false,
      };
    }
  },
  inputSchema: z.object({
    cursor: z
      .string()
      .optional()
      .describe(
        "The cursor returned by the previous page. Keep the same prefix."
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe("Maximum number of assets to return. Defaults to 1000."),
    prefix: z
      .string()
      .optional()
      .describe(
        'Filter by path prefix/folder, e.g. "drafts/". Omit to list everything.'
      ),
  }),
  outputSchema: z.object({
    assets: z.array(
      z.object({
        pathname: z.string(),
        size: z.number(),
        uploadedAt: z.string(),
        url: z.string(),
      })
    ),
    count: z.number(),
    cursor: z.string().optional(),
    error: z.string().optional(),
    hasMore: z.boolean(),
  }),
});
