import { createLogger } from "#internal/logging.js";

const log = createLogger("channel.background-work");

/**
 * How long eve waits for channel event handlers' `waitUntil` work before the step goes on
 * without it. Background work is meant for quick platform calls such as a status update; this
 * bound keeps one that never settles from holding the step until the host times it out.
 */
export const WAIT_UNTIL_TIMEOUT_MS = 30_000;

interface Work {
  readonly eventType: string;
  settled: boolean;
}

/** The work channel event handlers handed `ctx.waitUntil`, for one step. */
export interface BackgroundWork {
  /** The `waitUntil` for one handler call, labelled with its event type for logs. */
  waitUntilFor(eventType: string): (task: Promise<unknown>) => void;
  /**
   * Waits for the queued work, and work it queues while it runs, for up to `timeoutMs`. It never
   * throws: a rejection is logged, and work still running at the deadline is logged and left
   * behind. Returns whether there was any work to wait for.
   */
  settle(timeoutMs?: number): Promise<boolean>;
  /** Ends the step: work queued later is logged and never waited for. */
  close(): void;
}

export function createBackgroundWork(
  fields: { readonly adapterKind?: string } = {},
): BackgroundWork {
  let queued: { readonly work: Work; readonly done: Promise<void> }[] = [];
  let closed = false;
  return {
    waitUntilFor: (eventType) => (task) => {
      const work: Work = { eventType, settled: false };
      const done = Promise.resolve(task).then(
        () => {
          work.settled = true;
        },
        (error: unknown) => {
          work.settled = true;
          log.error("a channel event handler's waitUntil work failed", {
            ...fields,
            eventType,
            error,
          });
        },
      );
      if (closed) {
        log.warn(
          "a channel event handler called waitUntil after its step ended; eve won't wait for it",
          { ...fields, eventType },
        );
        return;
      }
      queued.push({ work, done });
    },
    async settle(timeoutMs = WAIT_UNTIL_TIMEOUT_MS) {
      if (queued.length === 0) return false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<"expired">((resolve) => {
        timer = setTimeout(() => resolve("expired"), timeoutMs);
      });
      try {
        while (queued.length > 0) {
          const batch = queued;
          queued = [];
          const outcome = await Promise.race([Promise.all(batch.map(({ done }) => done)), expired]);
          if (outcome !== "expired") continue;
          const pending = [...batch, ...queued].filter(({ work }) => !work.settled);
          queued = [];
          log.warn(
            "channel event handlers' waitUntil work didn't settle in time; the step goes on without it",
            {
              ...fields,
              eventTypes: [...new Set(pending.map(({ work }) => work.eventType))],
              timeoutMs,
            },
          );
          break;
        }
      } finally {
        clearTimeout(timer);
      }
      return true;
    },
    close() {
      closed = true;
    },
  };
}
