import { get } from "@vercel/blob";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { checkBlobUrl } from "#lib/blob-url.js";

const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_BINARY_BYTES = (MAX_TEXT_BYTES / 4) * 3;

/**
 * Tool that downloads the contents of a Vercel Blob asset.
 *
 * @remarks
 * The store is private, so the asset is read through the Blob SDK with the ambient Vercel OIDC
 * credentials; no `BLOB_READ_WRITE_TOKEN` is required. Text content is returned raw; binary
 * content (images, PDFs) is returned base64-encoded with `isBase64: true`. Only Vercel Blob URLs
 * are accepted (see {@link checkBlobUrl}). Downloads are limited to 1 MiB of text bytes
 * or 768 KiB of binary bytes, keeping base64 output within 1 MiB. The reader enforces the
 * limit independently of Blob metadata and uses one fixed buffer to bound memory even
 * when a stream sends many tiny chunks.
 */
export default defineTool({
  description:
    "Download and return the contents of a Vercel Blob asset. Use when the user wants to " +
    "read or reuse a stored file. Text is returned raw (up to 1 MiB); binary files come back " +
    "base64-encoded (up to 768 KiB before encoding). Split larger files before downloading.",
  /**
   * Fetch and return the asset contents.
   *
   * @param input - Validated tool input.
   * @returns The asset `content` (raw text or base64) with its `contentType`, or
   * `success: false` with an `error` message.
   */
  async execute({ url }) {
    const checked = checkBlobUrl(url);
    if (!checked.ok) {
      return { error: checked.error, success: false, url };
    }
    try {
      const result = await get(checked.url, { access: "private" });
      if (result?.statusCode !== 200) {
        return { error: "Asset not found.", success: false, url };
      }

      const { contentType } = result.blob;
      const isText =
        contentType.startsWith("text/") || contentType.includes("json");
      const maxBytes = isText ? MAX_TEXT_BYTES : MAX_BINARY_BYTES;
      const tooLarge = () =>
        new Error(
          `Asset too large: the download limit is ${maxBytes} bytes. Use a smaller asset or split the file before downloading.`
        );
      if (result.blob.size > maxBytes) {
        await result.stream.cancel().catch(() => undefined);
        throw tooLarge();
      }
      const bytes = Buffer.alloc(maxBytes);
      let length = 0;
      for await (const value of result.stream) {
        if (value.byteLength > maxBytes - length) {
          throw tooLarge();
        }
        bytes.set(value, length);
        length += value.byteLength;
      }
      const body = bytes.subarray(0, length);
      const content = isText
        ? new TextDecoder().decode(body)
        : body.toString("base64");

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
