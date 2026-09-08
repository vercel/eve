import { createLogger } from "#internal/logging.js";

export const INSTRUMENTATION_DRAIN_TIMEOUT_MS = 5_000;

const log = createLogger("instrumentation.drain");

/** A timed-out drain stays in flight, so later callers cannot pile up exporter work. */
export function createInstrumentationDrain(
  name: string,
  operation: () => void | PromiseLike<void>,
): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    if (pending !== undefined) return pending;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const running = Promise.resolve()
      .then(operation)
      .catch(() => log.warn("instrumentation drain failed", { operation: name }))
      .finally(() => {
        clearTimeout(timer);
        pending = undefined;
      });
    pending = Promise.race([
      running,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          log.warn("instrumentation drain timed out", {
            operation: name,
            timeoutMs: INSTRUMENTATION_DRAIN_TIMEOUT_MS,
          });
          resolve();
        }, INSTRUMENTATION_DRAIN_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
    return pending;
  };
}
