import type {
  SessionTimeoutControl,
  SessionTimeoutInput,
} from "#execution/session/timeout-control.js";

// Timers for sessions run in this process. Every wait is to an absolute deadline, so a session
// restored in another process keeps the deadline it had, and a wait longer than `setTimeout`
// allows (about 24.8 days; the default session timeout is 30) re-arms until it is due. Timers
// don't hold the process open: a host that is still serving keeps it alive itself.

const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export interface InProcessTimers {
  /** Resolves at `deadline` (epoch milliseconds), or never once the timers are disposed. */
  until(deadline: number): Promise<void>;
  /**
   * The earliest deadline still waited for, if any: when a host that stops before it must be
   * woken again.
   */
  next(): number | undefined;
  /** Clears every pending timer. */
  dispose(): void;
}

export function createInProcessTimers(now: () => number = Date.now): InProcessTimers {
  const pending = new Set<ReturnType<typeof setTimeout>>();
  /** Each wait's deadline, by how many wait for it. */
  const deadlines = new Map<number, number>();
  let disposed = false;
  return {
    next() {
      let earliest: number | undefined;
      for (const deadline of deadlines.keys())
        if (earliest === undefined || deadline < earliest) earliest = deadline;
      return earliest;
    },
    until(deadline) {
      deadlines.set(deadline, (deadlines.get(deadline) ?? 0) + 1);
      const settle = (): void => {
        const left = (deadlines.get(deadline) ?? 1) - 1;
        if (left === 0) deadlines.delete(deadline);
        else deadlines.set(deadline, left);
      };
      return new Promise<void>((resolve) => {
        const arm = (): void => {
          if (disposed) return;
          const remaining = deadline - now();
          if (remaining <= 0) {
            settle();
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

/**
 * One session's idle timeout, kept as Workflow's is: activity moves the deadline in memory, and
 * when the timer fires early the owner re-arms it for the new deadline. `signal` delivers the
 * session's `session-timeout` command, which the session loop admits like Workflow's.
 */
export function createInProcessTimeoutControl(
  input: SessionTimeoutInput & {
    readonly signal: () => void;
    readonly timers: InProcessTimers;
    readonly now?: () => number;
  },
): SessionTimeoutControl | undefined {
  const { signal, timeoutMs, timers } = input;
  if (timeoutMs === false) return undefined;
  const now = input.now ?? Date.now;
  let lastActivityAt = input.deadline === undefined ? now() : input.deadline.getTime() - timeoutMs;
  // Each arming gets a generation; a disposed or superseded timer signals nothing.
  let generation = 0;
  const arm = (): void => {
    const armed = ++generation;
    void timers.until(lastActivityAt + timeoutMs).then(() => {
      if (armed === generation) signal();
    });
  };
  return {
    getDeadline: () => new Date(lastActivityAt + timeoutMs),
    async dispose() {
      generation += 1;
    },
    async handleTimerElapsed() {
      if (now() >= lastActivityAt + timeoutMs) return "expired";
      arm();
      return "extended";
    },
    recordActivity() {
      lastActivityAt = now();
    },
    async start() {
      arm();
    },
  };
}
