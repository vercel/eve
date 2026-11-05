/**
 * Runs work in order per key: work for one key starts once the work queued before it for that
 * key settled, whether it succeeded or not. Work for other keys runs alongside.
 */
export interface SerialPerKey {
  run<T>(key: string, work: () => Promise<T>): Promise<T>;
  /** Resolves once the work queued for `key` so far settled; it never rejects. */
  settled(key: string): Promise<void>;
}

export function serialPerKey(): SerialPerKey {
  const tails = new Map<string, Promise<unknown>>();
  return {
    async run(key, work) {
      const done = (tails.get(key) ?? Promise.resolve()).then(work, work);
      tails.set(key, done);
      try {
        return await done;
      } finally {
        if (tails.get(key) === done) tails.delete(key);
      }
    },
    async settled(key) {
      await tails.get(key)?.catch(() => {});
    },
  };
}
