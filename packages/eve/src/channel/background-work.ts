import { createLogger } from "#internal/logging.js";

const log = createLogger("channel.background-work");

export const WAIT_UNTIL_TIMEOUT_MS = 30_000;

interface Work {
  readonly eventType: string;
  settled: boolean;
}

export interface BackgroundWork {
  waitUntilFor(eventType: string): (task: Promise<unknown>) => void;
  settle(timeoutMs?: number): Promise<boolean>;
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
