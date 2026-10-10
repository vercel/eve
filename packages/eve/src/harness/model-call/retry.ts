import { setTimeout as delay } from "node:timers/promises";

import { createLogger } from "#internal/logging.js";
import { classifyModelCallError } from "#harness/model-call/errors.js";

const log = createLogger("harness.tool-loop");
/**
 * Max attempts (1 original + N retries) for transient model-call
 * failures before the harness gives up and falls back to the
 * recoverable/terminal emission path. Kept small on purpose — every
 * attempt costs a round-trip plus prompt tokens, and the dominant
 * use case (429 / 502) clears quickly or not at all.
 */
const MODEL_CALL_MAX_ATTEMPTS = 3;

/**
 * Base delay (ms) between model-call retries. Doubled each attempt,
 * plus a small random jitter to avoid thundering-herd behavior when
 * a provider incident clears.
 */
const MODEL_CALL_RETRY_BASE_DELAY_MS = 500;

/**
 * Retries `fn` with exponential backoff while the thrown error is
 * classified as `"retry"`. Rethrows the last error once attempts are
 * exhausted or the error is classified as something other than
 * transient.
 */
export async function runModelCallWithRetries<T>(
  fn: (attempt: number) => Promise<T>,
  diag: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly canRetry?: () => boolean;
  },
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await fn(attempt);
    } catch (error) {
      signal?.throwIfAborted();
      if (
        diag.canRetry?.() === false ||
        attempt === MODEL_CALL_MAX_ATTEMPTS ||
        classifyModelCallError(error) !== "retry"
      ) {
        throw error;
      }
      const delayMs =
        MODEL_CALL_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
      log.warn("model call failed transiently — retrying", {
        attempt,
        delayMs,
        sessionId: diag.sessionId,
        turnId: diag.turnId,
        error,
      });
      await delay(delayMs, undefined, { signal });
    }
  }
}
