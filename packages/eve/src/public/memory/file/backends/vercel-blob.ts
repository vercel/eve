import { BlobPreconditionFailedError, get, put } from "#compiled/@vercel/blob/index.js";
import {
  MemoryDocumentConflictError,
  type MemoryDocument,
  type MemoryDocumentBackend,
  type MemoryDocumentReadInput,
} from "#public/memory/file/backend.js";

const DEFAULT_PREFIX = "eve/memory/file";

/** Credentials and pathname configuration for {@link vercelBlob}. */
export interface VercelBlobBackendOptions {
  /** Vercel Blob read-write token. Defaults to `BLOB_READ_WRITE_TOKEN`. */
  readonly token?: string;
  /** Vercel OIDC token. Defaults to `VERCEL_OIDC_TOKEN`. */
  readonly oidcToken?: string;
  /** Blob store ID used with OIDC. Defaults to `BLOB_STORE_ID`. */
  readonly storeId?: string;
  /** Object pathname prefix. Defaults to `eve/memory/file`. */
  readonly prefix?: string;
}

/** Creates a private Vercel Blob backend for bounded memory files. */
export function vercelBlob(options: VercelBlobBackendOptions = {}): MemoryDocumentBackend {
  const prefix = normalizePrefix(options.prefix ?? DEFAULT_PREFIX);
  const credentials = {
    oidcToken: options.oidcToken,
    storeId: options.storeId,
    token: options.token,
  };

  const read = async (input: MemoryDocumentReadInput): Promise<MemoryDocument | null> => {
    const result = await get(pathname(prefix, input.key), {
      ...credentials,
      abortSignal: input.signal,
      access: "private",
      useCache: false,
    });
    if (result === null) return null;
    if (result.statusCode !== 200 || result.stream === null) {
      throw new Error(`Vercel Blob returned ${result.statusCode} without a memory document.`);
    }
    return {
      content: await new Response(result.stream).text(),
      version: normalizeBlobEtag(result.blob.etag),
    };
  };

  return {
    read,
    async write(input) {
      try {
        const result = await put(pathname(prefix, input.key), input.content, {
          ...credentials,
          abortSignal: input.signal,
          access: "private",
          addRandomSuffix: false,
          allowOverwrite: input.expectedVersion !== null,
          contentType: "text/markdown; charset=utf-8",
          ifMatch: input.expectedVersion ?? undefined,
        });
        return { content: input.content, version: result.etag };
      } catch (error) {
        if (error instanceof BlobPreconditionFailedError) {
          throw new MemoryDocumentConflictError(input.key);
        }
        if (input.expectedVersion === null) {
          try {
            if ((await read(input)) !== null) {
              throw new MemoryDocumentConflictError(input.key);
            }
          } catch (readError) {
            if (MemoryDocumentConflictError.is(readError)) throw readError;
          }
        }
        throw error;
      }
    },
  };
}

function normalizePrefix(value: string): string {
  const prefix = value.replace(/^\/+|\/+$/g, "");
  if (prefix.length === 0) throw new TypeError("Vercel Blob memory prefix cannot be empty.");
  return prefix;
}

function normalizeBlobEtag(etag: string): string {
  // The CDN weakens the same object ETag when it compresses a response, but
  // Blob conditional writes require the underlying strong validator.
  return etag.startsWith("W/") ? etag.slice(2) : etag;
}

function pathname(prefix: string, key: string): string {
  return `${prefix}/${encodeURIComponent(key)}/MEMORY.md`;
}
