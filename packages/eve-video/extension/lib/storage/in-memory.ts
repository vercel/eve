import { normalizeStorageKey } from "./key.ts";
import type {
  StoredVideoContent,
  VideoStorage,
  VideoStorageDeleteInput,
  VideoStorageGetInput,
  VideoStorageVisibility,
} from "./types.ts";

/** Configuration options for {@link inMemory}. */
export interface InMemoryVideoStorageOptions {
  /** Optional base URL prefixed onto stored keys when generating returned URLs. */
  readonly baseUrl?: string;
  /** Visibility reported on stored videos. Defaults to `"public"` when `baseUrl` is set. */
  readonly visibility?: VideoStorageVisibility;
}

/** In-memory {@link VideoStorage} implementation with inspection helpers for tests and ephemeral runs. */
export interface InMemoryVideoStorage extends VideoStorage {
  /** Reads stored video bytes by key, returning `null` when not found. */
  readonly get: (input: VideoStorageGetInput) => Promise<StoredVideoContent | null>;
  /** Removes a stored video by key. */
  readonly delete: (input: VideoStorageDeleteInput) => Promise<void>;
  /** Returns all currently stored video keys in insertion order. */
  readonly keys: () => readonly string[];
  /** Removes all stored videos from memory. */
  readonly clear: () => void;
}

/** Creates an in-memory video storage adapter suitable for tests and ephemeral agents. */
export function inMemory(options: InMemoryVideoStorageOptions = {}): InMemoryVideoStorage {
  const baseUrl = options.baseUrl?.trim().replace(/\/+$/, "");
  if (options.baseUrl !== undefined && !baseUrl)
    throw new TypeError("In-memory video storage baseUrl cannot be empty.");
  const visibility = options.visibility ?? (baseUrl ? "public" : undefined);
  const entries = new Map<string, { readonly data: Uint8Array; readonly mediaType: string }>();
  return {
    async put({ key: rawKey, data, mediaType, signal }) {
      signal.throwIfAborted();
      const key = normalizeStorageKey(rawKey);
      const copy = Uint8Array.from(data);
      entries.set(key, { data: copy, mediaType });
      return {
        key,
        mediaType,
        bytes: copy.byteLength,
        ...(baseUrl && { url: `${baseUrl}/${key}` }),
        ...(visibility && { visibility }),
      };
    },
    async get({ key: rawKey, signal }) {
      signal.throwIfAborted();
      const key = normalizeStorageKey(rawKey);
      const entry = entries.get(key);
      return entry
        ? {
            key,
            data: Uint8Array.from(entry.data),
            mediaType: entry.mediaType,
            bytes: entry.data.byteLength,
          }
        : null;
    },
    async delete({ key, signal }) {
      signal.throwIfAborted();
      entries.delete(normalizeStorageKey(key));
    },
    keys: () => [...entries.keys()],
    clear: () => entries.clear(),
  };
}
