import { head } from "@vercel/blob";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { isReservedUrl, RESERVED_PATH_ERROR } from "#lib/reserved-paths.js";

/**
 * Tool that fetches metadata for a Vercel Blob asset without downloading its content.
 *
 * @remarks
 * Authorization resolves from the ambient Vercel OIDC credentials; no `BLOB_READ_WRITE_TOKEN`
 * is required. Use it to confirm an asset exists, or to check its size or content type before
 * downloading. Returns `exists: false` when the asset is not found.
 */
export default defineTool({
  description:
    "Get metadata (size, content type, upload date) for a Vercel Blob asset without " +
    "downloading it. Use to check whether an asset exists or inspect it before downloading.",
  /**
   * Look up the asset's metadata.
   *
   * @param input - Validated tool input.
   * @returns `exists: true` with the asset's metadata, or `exists: false` with an `error`.
   */
  async execute({ url }) {
    if (isReservedUrl(url)) {
      return {
        error: RESERVED_PATH_ERROR,
        exists: false,
        url,
      };
    }
    try {
      const metadata = await head(url);
      return {
        contentType: metadata.contentType,
        exists: true,
        pathname: metadata.pathname,
        size: metadata.size,
        uploadedAt: metadata.uploadedAt.toISOString(),
        url: metadata.url,
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Asset not found",
        exists: false,
        url,
      };
    }
  },
  inputSchema: z.object({
    url: z.url().describe("The full Blob URL of the asset to inspect."),
  }),
  outputSchema: z.object({
    contentType: z.string().optional(),
    error: z.string().optional(),
    exists: z.boolean(),
    pathname: z.string().optional(),
    size: z.number().optional(),
    uploadedAt: z.string().optional(),
    url: z.string(),
  }),
});
