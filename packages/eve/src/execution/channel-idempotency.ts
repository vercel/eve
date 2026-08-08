export const CHANNEL_IDEMPOTENCY_WINDOW_SIZE = 1_024;

export interface ChannelIdempotencyGuard {
  accept(key: string | undefined): boolean;
}

/** Tracks a deterministic, bounded window of accepted delivery keys for one session. */
export function createChannelIdempotencyGuard(initialKey?: string): ChannelIdempotencyGuard {
  const accepted = new Set<string>();
  if (initialKey !== undefined) accepted.add(initialKey);

  return {
    accept(key) {
      if (key === undefined) return true;
      if (accepted.has(key)) return false;

      accepted.add(key);
      if (accepted.size > CHANNEL_IDEMPOTENCY_WINDOW_SIZE) {
        const oldest = accepted.values().next().value;
        if (oldest !== undefined) accepted.delete(oldest);
      }
      return true;
    },
  };
}
