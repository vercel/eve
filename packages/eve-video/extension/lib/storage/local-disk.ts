import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { normalizeStorageKey } from "./key.ts";
import type { VideoStorage, VideoStorageVisibility } from "./types.ts";

const EXTENSION_MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
};

/** Configuration options for {@link localDisk}. */
export interface LocalDiskVideoStorageOptions {
  /** Root directory where videos are stored. Defaults to a temporary `eve-videos` directory. */
  readonly directory?: string;
  /** Optional `http://` or `https://` base URL exposed for stored files. */
  readonly publicBaseUrl?: string;
}

function normalizeDirectory(directory: string | undefined): string {
  if (directory === undefined) return resolve(join(tmpdir(), "eve-videos"));
  if (directory.trim().length === 0) {
    throw new TypeError("Local disk video storage directory cannot be empty.");
  }
  return resolve(directory);
}

function normalizePublicBaseUrl(publicBaseUrl: string | undefined): string | undefined {
  if (publicBaseUrl === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(publicBaseUrl);
  } catch {
    throw new TypeError(`Invalid local disk publicBaseUrl "${publicBaseUrl}".`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError(
      `Invalid local disk publicBaseUrl "${publicBaseUrl}": only http:// and https:// URLs are supported.`,
    );
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new TypeError(
      `Invalid local disk publicBaseUrl "${publicBaseUrl}": query strings and fragments are not supported.`,
    );
  }
  return parsed.toString().replace(/\/+$/, "");
}

function resolveTarget(root: string, key: string): { normalizedKey: string; target: string } {
  const normalizedKey = normalizeStorageKey(key);
  const target = resolve(root, ...normalizedKey.split("/"));
  const rel = relative(root, target);
  if (
    rel.length === 0 ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    rel.startsWith("../") ||
    isAbsolute(rel)
  ) {
    throw new TypeError(`Video storage key "${key}" escapes the configured storage directory.`);
  }
  return { normalizedKey, target };
}

function detectMediaType(key: string): string {
  const ext = extname(key).toLowerCase();
  return EXTENSION_MEDIA_TYPES[ext] ?? "application/octet-stream";
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** Creates a local filesystem video storage adapter with atomic writes. */
export function localDisk(options: LocalDiskVideoStorageOptions = {}): VideoStorage {
  const root = normalizeDirectory(options.directory);
  const publicBaseUrl = normalizePublicBaseUrl(options.publicBaseUrl);

  return {
    async put(input) {
      input.signal.throwIfAborted();
      const { normalizedKey, target } = resolveTarget(root, input.key);
      const directory = dirname(target);
      await mkdir(directory, { recursive: true });

      const tempPath = join(directory, `.tmp-${randomUUID()}`);
      try {
        await writeFile(tempPath, input.data, { signal: input.signal });
        input.signal.throwIfAborted();
        await rename(tempPath, target);
      } catch (error) {
        await rm(tempPath, { force: true }).catch(() => {});
        throw error;
      }

      const stored: {
        key: string;
        url?: string;
        path: string;
        mediaType: string;
        bytes: number;
        visibility?: VideoStorageVisibility;
      } = {
        key: normalizedKey,
        path: target,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
      };
      if (publicBaseUrl !== undefined) {
        stored.url = `${publicBaseUrl}/${normalizedKey}`;
        stored.visibility = "public";
      }
      return stored;
    },

    async get(input) {
      input.signal.throwIfAborted();
      const { normalizedKey, target } = resolveTarget(root, input.key);
      let buffer: Buffer;
      try {
        buffer = await readFile(target, { signal: input.signal });
      } catch (error) {
        if (isNotFoundError(error)) return null;
        throw error;
      }
      const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      return {
        key: normalizedKey,
        data,
        mediaType: detectMediaType(normalizedKey),
        bytes: data.byteLength,
      };
    },

    async delete(input) {
      input.signal.throwIfAborted();
      const { target } = resolveTarget(root, input.key);
      await rm(target, { force: true });
    },
  };
}
