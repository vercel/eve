export interface SlackLookupCacheOptions {
  readonly failedTtlMs: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
  readonly ttlMs: number;
}

export interface SlackLookupResult<T> {
  readonly failed?: boolean;
  readonly value: T;
}

export interface SlackLookupCache<T> {
  getOrLoad(key: string, load: () => Promise<SlackLookupResult<T>>): Promise<T>;
  set(key: string, value: T, ttlMs?: number): void;
}

const DEFAULT_MAX_ENTRIES = 1_000;

export function createSlackLookupCache<T>(options: SlackLookupCacheOptions): SlackLookupCache<T> {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const now = options.now ?? (() => Date.now());
  const cache = new Map<string, { readonly expiresAt: number; readonly value: Promise<T> }>();

  const store = (key: string, value: Promise<T>, expiresAt: number) => {
    cache.delete(key);
    if (cache.size >= maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { expiresAt, value });
  };

  return {
    getOrLoad(key, load) {
      const hit = cache.get(key);
      if (hit !== undefined && hit.expiresAt > now()) return hit.value;

      const startedAt = now();
      const pending = load().then(
        (result) => {
          if (result.failed === true && cache.get(key)?.value === pending) {
            cache.set(key, { expiresAt: startedAt + options.failedTtlMs, value: pending });
          }
          return result.value;
        },
        (error: unknown) => {
          if (cache.get(key)?.value === pending) cache.delete(key);
          throw error;
        },
      );
      store(key, pending, startedAt + options.ttlMs);
      return pending;
    },

    set(key, value, ttlMs = options.ttlMs) {
      store(key, Promise.resolve(value), now() + ttlMs);
    },
  };
}
