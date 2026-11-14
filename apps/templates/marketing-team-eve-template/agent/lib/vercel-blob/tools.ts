import { del, get, head, list, put } from "@vercel/blob";
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import {
  BLOB_HOST_SUFFIX,
  MAX_ASSET_CONTENT_LENGTH,
  MAX_CONTENT_TYPE_LENGTH,
  MAX_PATHNAME_LENGTH,
  reservedNamespaceForPath,
  reservedNamespaceForUrl,
  reservedReadMessage,
  reservedWriteMessage,
} from "#lib/vercel-blob/config.js";

/**
 * Shared definitions for the team's Vercel Blob asset tools.
 *
 * @remarks
 * eve resolves an agent's tools from its own `tools/` directory and subagents inherit nothing, so
 * every specialist that needs durable file storage calls these factories from one-line files.
 * Defining them once here means each agent gets the same descriptions, schemas, and reserved-path
 * guards: a guard that only some agents apply is not a guard.
 *
 * The store is private. Every object is written with `access: "private"` and read through the SDK
 * with the project's credentials, so a Blob URL is an identifier for these tools and not a link
 * anyone can open. The tool descriptions say so, because a model that hands a user a private URL
 * as a link has handed them a 403.
 *
 * @packageDocumentation
 */

const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_BINARY_BYTES = (MAX_TEXT_BYTES / 4) * 3;

const readAssetBytes = async (
  stream: ReadableStream<Uint8Array>,
  size: number,
  maxBytes: number
): Promise<Buffer> => {
  const tooLarge = () =>
    new Error(
      `Asset too large: the download limit is ${maxBytes} bytes. Use a smaller asset or split the file before downloading.`
    );
  if (size > maxBytes) {
    await stream.cancel().catch(() => undefined);
    throw tooLarge();
  }
  const bytes = Buffer.alloc(maxBytes);
  let length = 0;
  for await (const value of stream) {
    if (value.byteLength > maxBytes - length) {
      throw tooLarge();
    }
    bytes.set(value, length);
    length += value.byteLength;
  }
  return bytes.subarray(0, length);
};

/**
 * Build the tool that uploads text or binary content to Blob storage.
 *
 * @remarks
 * Refuses paths in a reserved namespace so a generic upload can't overwrite a managed document.
 * Binary content is supplied base64-encoded with `isBase64: true`.
 *
 * @returns The `upload_asset` tool definition.
 */
export const uploadAssetTool = () =>
  defineTool({
    description:
      "Upload text or binary content to the team's private Vercel Blob storage and return its " +
      "URL. Use when the user wants to keep an asset, such as an exported draft or an image, in " +
      "durable storage. The URL identifies the asset for the other asset tools. It is not a " +
      "link: the store is private, so don't give it to the user to open or pass it to another " +
      "service to fetch.",
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
      const reserved = reservedNamespaceForPath(pathname);
      if (reserved) {
        return {
          contentType: contentType ?? "unknown",
          error: reservedWriteMessage(reserved),
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
        .max(MAX_ASSET_CONTENT_LENGTH)
        .describe(
          "Raw text/JSON, or base64-encoded bytes when isBase64 is true."
        ),
      contentType: z
        .string()
        .max(MAX_CONTENT_TYPE_LENGTH)
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
        .max(MAX_PATHNAME_LENGTH)
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

/**
 * Build the tool that lists assets in Blob storage.
 *
 * @remarks
 * Objects in a reserved namespace are filtered out of the results, so managed documents don't show
 * up as browsable files.
 *
 * @returns The `list_assets` tool definition.
 */
export const listAssetsTool = () =>
  defineTool({
    description:
      "List assets in Vercel Blob storage, optionally filtered by a path prefix. Returns each " +
      "asset's URL, size, and upload date. Use to browse stored content or locate an asset. " +
      "Each URL is an identifier for the asset tools, not a link the user can open. " +
      "When hasMore is true, pass the returned cursor with the same prefix to get the next " +
      "page, even if the current page has no visible assets.",
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
        const visible = blobs.filter(
          (blob) => !reservedNamespaceForPath(blob.pathname)
        );
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
          error:
            error instanceof Error ? error.message : "Failed to list assets",
          hasMore: false,
        };
      }
    },
    inputSchema: z.object({
      cursor: z
        .string()
        .max(8192)
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
        .max(MAX_PATHNAME_LENGTH)
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

/**
 * Build the tool that reads an asset's metadata without downloading it.
 *
 * @returns The `get_asset_info` tool definition.
 */
export const getAssetInfoTool = () =>
  defineTool({
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
      const reserved = reservedNamespaceForUrl(url);
      if (reserved) {
        return {
          error: reservedReadMessage(reserved),
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

/**
 * Build the tool that downloads an asset's contents.
 *
 * @remarks
 * The `url` is model-supplied, so it is checked against {@link BLOB_HOST_SUFFIX} before the fetch:
 * without that check this tool is an SSRF primitive. Text content is returned raw; binary content
 * comes back base64-encoded with `isBase64: true`. Downloads are limited to 1 MiB of text bytes
 * or 768 KiB of binary bytes, keeping base64 output within 1 MiB. The reader enforces the
 * limit independently of Blob metadata and uses one fixed buffer to bound memory even
 * when a stream sends many tiny chunks.
 *
 * @returns The `download_asset` tool definition.
 */
export const downloadAssetTool = () =>
  defineTool({
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
      const reserved = reservedNamespaceForUrl(url);
      if (reserved) {
        return {
          error: reservedReadMessage(reserved),
          success: false,
          url,
        };
      }
      try {
        if (!new URL(url).hostname.endsWith(BLOB_HOST_SUFFIX)) {
          return {
            error:
              "Refusing to download: only Vercel Blob URLs " +
              `(*${BLOB_HOST_SUFFIX}) are allowed.`,
            success: false,
            url,
          };
        }

        const result = await get(url, { access: "private" });
        if (result?.statusCode !== 200) {
          return { error: "Asset not found.", success: false, url };
        }

        const contentType =
          result.blob.contentType ?? "application/octet-stream";
        const isText =
          contentType.startsWith("text/") || contentType.includes("json");
        const maxBytes = isText ? MAX_TEXT_BYTES : MAX_BINARY_BYTES;
        const body = await readAssetBytes(
          result.stream,
          result.blob.size,
          maxBytes
        );
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
      url: z
        .url()
        .describe("The full Vercel Blob URL of the asset to download."),
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

/**
 * Build the tool that permanently deletes an asset.
 *
 * @remarks
 * Deletion is irreversible, so this tool is gated on human approval on every call. Reserved
 * namespaces are refused, so a managed document can't be removed through this tool.
 *
 * @returns The `delete_asset` tool definition.
 */
export const deleteAssetTool = () =>
  defineTool({
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
      const reserved = reservedNamespaceForUrl(url);
      if (reserved) {
        return {
          deleted: false,
          error: reservedWriteMessage(reserved),
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
