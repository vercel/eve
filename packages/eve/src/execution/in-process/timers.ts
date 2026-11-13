// Timers for sessions and runs in this process. Every wait is to an absolute deadline, and a wait
// longer than `setTimeout` allows (about 24.8 days) re-arms until it is due. Timers don't hold the
// process open: a host that is still serving keeps it alive itself.

const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export interface InProcessTimers {
  /** Resolves at `deadline` (epoch milliseconds), or never once the timers are disposed. */
  until(deadline: number): Promise<void>;
  /** Clears every pending timer. */
  dispose(): void;
}

export function createInProcessTimers(now: () => number = Date.now): InProcessTimers {
  const pending = new Set<ReturnType<typeof setTimeout>>();
  let disposed = false;
  return {
    until(deadline) {
      return new Promise<void>((resolve) => {
        const arm = (): void => {
          if (disposed) return;
          const remaining = deadline - now();
          if (remaining <= 0) {
            resolve();
            return;
          }
          const timer = setTimeout(
            () => {
              pending.delete(timer);
              arm();
            },
            Math.min(remaining, MAX_TIMEOUT_MS),
          );
          timer.unref?.();
          pending.add(timer);
        };
        arm();
      });
    },
    dispose() {
      disposed = true;
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
    },
  };
}
