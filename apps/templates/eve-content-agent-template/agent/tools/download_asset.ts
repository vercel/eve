import { get } from "@vercel/blob";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { isReservedUrl, RESERVED_PATH_ERROR } from "#lib/reserved-paths.js";

/**
 * Host suffix that a downloadable URL must end with.
 *
 * @remarks
 * Restricting downloads to Vercel Blob hosts prevents this tool from being used to fetch
 * arbitrary internal or third-party URLs (an SSRF vector), since the `url` is model-supplied.
 */
const BLOB_HOST_SUFFIX = ".blob.vercel-storage.com";

/**
 * Tool that downloads the contents of a Vercel Blob asset.
 *
 * @remarks
 * The store is private, so the asset is read through the Blob SDK with the ambient Vercel OIDC
 * credentials; no `BLOB_READ_WRITE_TOKEN` is required. Text content is returned raw; binary
 * content (images, PDFs) is returned base64-encoded with `isBase64: true`. Only Vercel Blob URLs
 * are accepted (see {@link BLOB_HOST_SUFFIX}).
 */
export default defineTool({
  description:
    "Download and return the contents of a Vercel Blob asset. Use when the writer wants to " +
    "read or reuse a stored file. Text is returned raw; binary files come back base64-encoded.",
  /**
   * Fetch and return the asset contents.
   *
   * @param input - Validated tool input.
   * @returns The asset `content` (raw text or base64) with its `contentType`, or
   * `success: false` with an `error` message.
   */
  async execute({ url }) {
    if (isReservedUrl(url)) {
      return {
        error: RESERVED_PATH_ERROR,
        success: false,
        url,
      };
    }
    try {
      if (!new URL(url).hostname.endsWith(BLOB_HOST_SUFFIX)) {
        return {
          error: `Refusing to download: only Vercel Blob URLs (*${BLOB_HOST_SUFFIX}) are allowed.`,
          success: false,
          url,
        };
      }

      const result = await get(url, { access: "private" });
      if (result?.statusCode !== 200) {
        return { error: "Asset not found.", success: false, url };
      }

      const { contentType } = result.blob;
      const isText =
        contentType.startsWith("text/") || contentType.includes("json");
      const body = new Response(result.stream);
      const content = isText
        ? await body.text()
        : Buffer.from(await body.arrayBuffer()).toString("base64");

      return { content, contentType, isBase64: !isText, success: true, url };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Download failed",
        success: false,
        url,
      };
    }
  },
  inputSchema: z.object({
    url: z.url().describe("The full Vercel Blob URL of the asset to download."),
  }),
  outputSchema: z.object({
    content: z.string().optional(),
    contentType: z.string().optional(),
    error: z.string().optional(),
    isBase64: z.boolean().optional(),
    success: z.boolean(),
    url: z.string(),
  }),
});
