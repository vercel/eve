import { setTimeout as delay } from "node:timers/promises";

import { createLogger } from "#internal/logging.js";
import { classifyModelCallError } from "#harness/model-call/errors.js";
import { decide, type Policy, type Restriction } from "#reactions/policy.js";

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

/** Whether a failed model call is tried again, and how long to wait first. */
export type RetryDecision =
  | { readonly retry: false }
  | { readonly retry: true; readonly delayMs: number };

/** A failed attempt: which one it was, and what it threw. */
export interface RetryQuestion {
  readonly attempt: number;
  readonly error: unknown;
}

export type RetryPolicy = Policy<RetryQuestion, RetryDecision>;

/** A policy's answer when it has no objection to a retry, or when it stops one. */
export const ALLOW_RETRY: RetryDecision = { delayMs: 0, retry: true };
export const STOP_RETRY: RetryDecision = { retry: false };

/** Any policy stops a retry; the longest wait any asks for is the wait. */
const retryLaw: Restriction<RetryDecision> = {
  meet: (a, b) =>
    !a.retry ? a : !b.retry ? b : { delayMs: Math.max(a.delayMs, b.delayMs), retry: true },
  open: ALLOW_RETRY,
};

// eve's own policies: only transient failures retry, a few times, backing off with jitter.
const BUILT_IN: readonly RetryPolicy[] = [
  ({ error }) => (classifyModelCallError(error) === "retry" ? ALLOW_RETRY : STOP_RETRY),
  ({ attempt }) => (attempt < MODEL_CALL_MAX_ATTEMPTS ? ALLOW_RETRY : STOP_RETRY),
  ({ attempt }) => ({
    delayMs: MODEL_CALL_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 250),
    retry: true,
  }),
];

/**
 * Retries `fn` while eve's retry policies and the caller's `policies` all allow it, waiting the
 * longest any asks for. Rethrows the last error once one stops it. `onRetry` hears each decision
 * to retry, before the wait.
 */
export async function runModelCallWithRetries<T>(
  fn: () => Promise<T>,
  diag: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly policies?: readonly RetryPolicy[];
    readonly onRetry?: (error: unknown) => Promise<void>;
  },
  signal?: AbortSignal,
): Promise<T> {
  const policies = [...BUILT_IN, ...(diag.policies ?? [])];
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await fn();
    } catch (error) {
      signal?.throwIfAborted();
      const decision = decide(retryLaw, policies, { attempt, error });
      if (!decision.retry) throw error;
      const { delayMs } = decision;
      log.warn("model call failed transiently — retrying", {
        attempt,
        delayMs,
        sessionId: diag.sessionId,
        turnId: diag.turnId,
        error,
      });
      await diag.onRetry?.(error);
      await delay(delayMs, undefined, { signal });
    }
  }
}
