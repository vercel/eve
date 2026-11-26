import {
  del,
  get,
  put,
  type DeleteCommandOptions,
  type GetCommandOptions,
  type PutCommandOptions,
} from "@vercel/blob";
import { normalizeStorageKey } from "./key.ts";
import type { VideoStorage, VideoStorageVisibility } from "./types.ts";

const DEFAULT_PREFIX = "eve/video";
const MULTIPART_THRESHOLD_BYTES = 5 * 1024 * 1024;

interface ResolvedBlobCredentials {
  readonly token?: string;
  readonly oidcToken?: string;
  readonly storeId?: string;
}

/** Configuration options for {@link vercelBlob}. */
export interface VercelBlobVideoStorageOptions {
  /** Visibility of uploaded video blobs. Defaults to `"public"`. */
  readonly access?: VideoStorageVisibility;
  /** Vercel Blob read-write token. Defaults to `EVE_VIDEO_BLOB_READ_WRITE_TOKEN`, then `BLOB_READ_WRITE_TOKEN`. */
  readonly token?: string;
  /** Vercel OIDC token. Defaults to `VERCEL_OIDC_TOKEN` or automatic Vercel OIDC when omitted. */
  readonly oidcToken?: string;
  /** Blob store ID used with Vercel OIDC authentication. Defaults to `EVE_VIDEO_BLOB_STORE_ID`, then `BLOB_STORE_ID`. */
  readonly storeId?: string;
  /** Pathname prefix prepended to stored video keys. Defaults to `"eve/video"`. */
  readonly prefix?: string;
  /** Whether Vercel Blob appends a random suffix to uploaded pathnames. Defaults to `false`. */
  readonly addRandomSuffix?: boolean;
  /** Whether uploads may overwrite an existing blob at the same pathname. Defaults to `true`. */
  readonly allowOverwrite?: boolean;
  /** Cache-Control max-age duration in seconds for uploaded video blobs. */
  readonly cacheControlMaxAge?: number;
  /** Default retention period in days before Vercel Blob automatically deletes uploaded videos. */
  readonly ttlDays?: number;
  /** Whether to use multipart upload. Defaults to automatic multipart above 5 MiB. */
  readonly multipart?: boolean;
}

function readTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

function normalizePrefix(value: string): string {
  const stripped = value.replace(/^\/+|\/+$/g, "");
  if (stripped.length === 0) {
    throw new TypeError("Vercel Blob video prefix cannot be empty.");
  }
  return normalizeStorageKey(stripped);
}

function resolveCredentials(options: VercelBlobVideoStorageOptions): ResolvedBlobCredentials {
  const explicitToken = readTrimmed(options.token);
  if (explicitToken !== undefined) {
    return { token: explicitToken };
  }

  const explicitOidcToken = readTrimmed(options.oidcToken);
  const explicitStoreId = readTrimmed(options.storeId);
  if (explicitOidcToken !== undefined || explicitStoreId !== undefined) {
    const storeId =
      explicitStoreId ??
      (explicitOidcToken !== undefined
        ? readTrimmed(process.env.EVE_VIDEO_BLOB_STORE_ID)
        : undefined);
    return {
      ...(explicitOidcToken !== undefined && { oidcToken: explicitOidcToken }),
      ...(storeId !== undefined && { storeId }),
    };
  }

  const videoStoreId = readTrimmed(process.env.EVE_VIDEO_BLOB_STORE_ID);
  const videoToken = readTrimmed(process.env.EVE_VIDEO_BLOB_READ_WRITE_TOKEN);
  if (
    videoStoreId !== undefined &&
    (readTrimmed(process.env.VERCEL_OIDC_TOKEN) !== undefined || videoToken === undefined)
  ) {
    return { storeId: videoStoreId };
  }
  if (videoToken !== undefined) {
    return { token: videoToken };
  }

  return {};
}

/** Creates a Vercel Blob video storage adapter for eve agents. */
export function vercelBlob(options: VercelBlobVideoStorageOptions = {}): VideoStorage {
  const access: VideoStorageVisibility = options.access ?? "public";
  const prefix = normalizePrefix(options.prefix ?? DEFAULT_PREFIX);
  const addRandomSuffix = options.addRandomSuffix ?? false;
  const allowOverwrite = options.allowOverwrite ?? true;

  return {
    async put(input) {
      input.signal.throwIfAborted();
      const normalizedKey = normalizeStorageKey(input.key);
      const pathname = `${prefix}/${normalizedKey}`;
      const body = Buffer.from(input.data.buffer, input.data.byteOffset, input.data.byteLength);
      const ttlDays = input.ttlDays ?? options.ttlDays;

      const putOptions: PutCommandOptions = {
        access,
        addRandomSuffix,
        allowOverwrite,
        contentType: input.mediaType,
        multipart: options.multipart ?? input.data.byteLength > MULTIPART_THRESHOLD_BYTES,
        abortSignal: input.signal,
        ...resolveCredentials(options),
        ...(options.cacheControlMaxAge !== undefined && {
          cacheControlMaxAge: options.cacheControlMaxAge,
        }),
        ...(ttlDays !== undefined && { ttlDays }),
      };

      const result = await put(pathname, body, putOptions);
      const logicalKey = addRandomSuffix
        ? result.pathname.startsWith(`${prefix}/`)
          ? result.pathname.slice(prefix.length + 1)
          : result.pathname
        : normalizedKey;

      return {
        key: logicalKey,
        url: result.url,
        downloadUrl: result.downloadUrl,
        mediaType: result.contentType || input.mediaType,
        bytes: input.data.byteLength,
        visibility: access,
        ...(result.expiresAt !== undefined && { expiresAt: result.expiresAt.toISOString() }),
      };
    },

    async get(input) {
      input.signal.throwIfAborted();
      const normalizedKey = normalizeStorageKey(input.key);
      const pathname = `${prefix}/${normalizedKey}`;
      const getOptions: GetCommandOptions = {
        access,
        abortSignal: input.signal,
        ...resolveCredentials(options),
      };

      const result = await get(pathname, getOptions);
      if (result === null) return null;
      if (result.statusCode !== 200 || result.stream === null) {
        throw new Error(`Vercel Blob returned ${result.statusCode} without a video stream.`);
      }
      const data = new Uint8Array(await new Response(result.stream).arrayBuffer());
      return {
        key: normalizedKey,
        data,
        mediaType: result.blob.contentType || "application/octet-stream",
        bytes: data.byteLength,
      };
    },

    async delete(input) {
      input.signal.throwIfAborted();
      const normalizedKey = normalizeStorageKey(input.key);
      const pathname = `${prefix}/${normalizedKey}`;
      const deleteOptions: DeleteCommandOptions = {
        abortSignal: input.signal,
        ...resolveCredentials(options),
      };

      await del(pathname, deleteOptions);
    },
  };
}
