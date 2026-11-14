import { put } from "@vercel/blob";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { isReservedPath, RESERVED_PATH_ERROR } from "#lib/reserved-paths.js";

/**
 * Tool that uploads text or binary content to Vercel Blob storage.
 *
 * @remarks
 * Authorization resolves from the ambient Vercel credentials (the project's OIDC token:
 * `VERCEL_OIDC_TOKEN`, or the `x-vercel-oidc-token` request header on Vercel), so no
 * `BLOB_READ_WRITE_TOKEN` is required and no token is passed in code. Binary content (images,
 * PDFs) is supplied base64-encoded with `isBase64: true`. The project's Blob store is private,
 * so every asset is written with private access.
 */
export default defineTool({
  description:
    "Upload text or binary content to Vercel Blob storage and return its URL. Use when the " +
    "user wants to save an asset, such as an exported draft or an image, to durable storage. The " +
    "store is private: the URL identifies the asset for the other asset tools, and it can't " +
    "be opened in a browser.",
  /**
   * Upload the content to Blob storage.
   *
   * @param input - Validated tool input.
   * @returns The asset's `url`, stored `pathname`, and `contentType`, or
   * `success: false` with an `error` message.
   */
  async execute({
    pathname,
    content,
    contentType,
    isBase64,
    addRandomSuffix,
    allowOverwrite,
  }) {
    if (isReservedPath(pathname)) {
      return {
        contentType: contentType ?? "unknown",
        error: RESERVED_PATH_ERROR,
        pathname,
        success: false,
        url: "",
      };
    }
    try {
      const body = isBase64 ? Buffer.from(content, "base64") : content;
      const blob = await put(pathname, body, {
        access: "private",
        addRandomSuffix: addRandomSuffix ?? false,
        allowOverwrite: allowOverwrite ?? false,
        contentType,
      });
      return {
        contentType: blob.contentType,
        pathname: blob.pathname,
        success: true,
        url: blob.url,
      };
    } catch (error) {
      return {
        contentType: contentType ?? "unknown",
        error: error instanceof Error ? error.message : "Upload failed",
        pathname,
        success: false,
        url: "",
      };
    }
  },
  inputSchema: z.object({
    addRandomSuffix: z
      .boolean()
      .optional()
      .describe(
        "Append a random suffix to avoid pathname collisions. Defaults to false."
      ),
    allowOverwrite: z
      .boolean()
      .optional()
      .describe(
        "Allow overwriting an existing blob at the same pathname. Defaults to false."
      ),
    content: z
      .string()
      .describe(
        "Raw text/JSON, or base64-encoded bytes when isBase64 is true."
      ),
    contentType: z
      .string()
      .optional()
      .describe(
        'MIME type, e.g. "text/markdown". Inferred from the extension when omitted.'
      ),
    isBase64: z
      .boolean()
      .optional()
      .describe(
        "Set true when content is base64-encoded binary data. Defaults to false."
      ),
    pathname: z
      .string()
      .min(1)
      .describe(
        'Path and filename including extension, e.g. "drafts/launch-post.md".'
      ),
  }),
  outputSchema: z.object({
    contentType: z.string(),
    error: z.string().optional(),
    pathname: z.string(),
    success: z.boolean(),
    url: z.string(),
  }),
});
