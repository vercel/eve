import { del, get, put } from "@vercel/blob";

import { normalizeStorageKey } from "./key.ts";
import type { VideoStorage, VideoStorageVisibility } from "./types.ts";

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

const trim = (v: string | undefined) => (v?.trim() ? v.trim() : undefined);

function creds(o: VercelBlobVideoStorageOptions) {
  const token = trim(o.token);
  if (token) return { token };
  const [oidcToken, explicitStore] = [trim(o.oidcToken), trim(o.storeId)];
  if (oidcToken || explicitStore) {
    const storeId = explicitStore ?? trim(process.env.EVE_VIDEO_BLOB_STORE_ID);
    return { ...(oidcToken && { oidcToken }), ...(storeId && { storeId }) };
  }
  const [vStore, vToken] = [
    trim(process.env.EVE_VIDEO_BLOB_STORE_ID),
    trim(process.env.EVE_VIDEO_BLOB_READ_WRITE_TOKEN),
  ];
  if (vStore && (trim(process.env.VERCEL_OIDC_TOKEN) || !vToken)) return { storeId: vStore };
  return vToken ? { token: vToken } : {};
}

/** Creates a Vercel Blob video storage adapter for eve agents. */
export function vercelBlob(options: VercelBlobVideoStorageOptions = {}): VideoStorage {
  const access: VideoStorageVisibility = options.access ?? "public";
  const rawPrefix = (options.prefix ?? "eve/video").replace(/^\/+|\/+$/g, "");
  if (!rawPrefix) throw new TypeError("Vercel Blob video prefix cannot be empty.");
  const prefix = normalizeStorageKey(rawPrefix);

  return {
    async put({ key: rawKey, data, mediaType, ttlDays: itemTtl, signal }) {
      signal.throwIfAborted();
      const key = normalizeStorageKey(rawKey);
      const body = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      const ttlDays = itemTtl ?? options.ttlDays;
      const res = await put(`${prefix}/${key}`, body, {
        access,
        addRandomSuffix: options.addRandomSuffix ?? false,
        allowOverwrite: options.allowOverwrite ?? true,
        contentType: mediaType,
        multipart: options.multipart ?? data.byteLength > 5 * 1024 * 1024,
        abortSignal: signal,
        ...creds(options),
        ...(options.cacheControlMaxAge !== undefined && {
          cacheControlMaxAge: options.cacheControlMaxAge,
        }),
        ...(ttlDays !== undefined && { ttlDays }),
      });
      const logicalKey = options.addRandomSuffix
        ? res.pathname.startsWith(`${prefix}/`)
          ? res.pathname.slice(prefix.length + 1)
          : res.pathname
        : key;
      return {
        key: logicalKey,
        url: res.url,
        downloadUrl: res.downloadUrl,
        mediaType: res.contentType || mediaType,
        bytes: data.byteLength,
        visibility: access,
        ...(res.expiresAt && { expiresAt: res.expiresAt.toISOString() }),
      };
    },
    async get({ key: rawKey, signal }) {
      signal.throwIfAborted();
      const key = normalizeStorageKey(rawKey);
      const res = await get(`${prefix}/${key}`, { access, abortSignal: signal, ...creds(options) });
      if (!res) return null;
      if (res.statusCode !== 200 || !res.stream)
        throw new Error(`Vercel Blob returned ${res.statusCode} without a video stream.`);
      const data = new Uint8Array(await new Response(res.stream).arrayBuffer());
      return {
        key,
        data,
        mediaType: res.blob.contentType || "application/octet-stream",
        bytes: data.byteLength,
      };
    },
    async delete({ key, signal }) {
      signal.throwIfAborted();
      await del(`${prefix}/${normalizeStorageKey(key)}`, {
        abortSignal: signal,
        ...creds(options),
      });
    },
  };
}
