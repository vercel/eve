import { normalizeStorageKey } from "./key.ts";
import type {
  StoredVideoContent,
  VideoStorage,
  VideoStorageDeleteInput,
  VideoStorageGetInput,
  VideoStorageVisibility,
} from "./types.ts";

interface InMemoryEntry {
  readonly data: Uint8Array;
  readonly mediaType: string;
}

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

function normalizeBaseUrl(baseUrl: string | undefined): string | undefined {
  if (baseUrl === undefined) return undefined;
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) {
    throw new TypeError("In-memory video storage baseUrl cannot be empty.");
  }
  return trimmed;
}

/** Creates an in-memory video storage adapter suitable for tests and ephemeral agents. */
export function inMemory(options: InMemoryVideoStorageOptions = {}): InMemoryVideoStorage {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const visibility = options.visibility ?? (baseUrl !== undefined ? "public" : undefined);
  const entries = new Map<string, InMemoryEntry>();

  return {
    async put(input) {
      input.signal.throwIfAborted();
      const key = normalizeStorageKey(input.key);
      const copy = Uint8Array.from(input.data);
      entries.set(key, {
        data: copy,
        mediaType: input.mediaType,
      });

      const stored: {
        key: string;
        url?: string;
        mediaType: string;
        bytes: number;
        visibility?: VideoStorageVisibility;
      } = {
        key,
        mediaType: input.mediaType,
        bytes: copy.byteLength,
      };
      if (baseUrl !== undefined) {
        stored.url = `${baseUrl}/${key}`;
      }
      if (visibility !== undefined) {
        stored.visibility = visibility;
      }
      return stored;
    },

    async get(input) {
      input.signal.throwIfAborted();
      const key = normalizeStorageKey(input.key);
      const entry = entries.get(key);
      if (entry === undefined) return null;
      return {
        key,
        data: Uint8Array.from(entry.data),
        mediaType: entry.mediaType,
        bytes: entry.data.byteLength,
      };
    },

    async delete(input) {
      input.signal.throwIfAborted();
      const key = normalizeStorageKey(input.key);
      entries.delete(key);
    },

    keys() {
      return [...entries.keys()];
    },

    clear() {
      entries.clear();
    },
  };
}
