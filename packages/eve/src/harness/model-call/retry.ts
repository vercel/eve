import { createLogger } from "#internal/logging.js";
import { classifyModelCallError } from "#harness/model-call/errors.js";
import { summarizeKnownError } from "#harness/semantic-errors/index.js";
import { throwIfSessionStreamDead } from "#harness/session-stream-write-error.js";
import { decide, type Policy, type Restriction } from "#shared/restriction.js";
import { delay } from "#runtime-env/delay.js";

const log = createLogger("harness.tool-loop");
const MODEL_CALL_MAX_ATTEMPTS = 3;

const GATEWAY_STREAM_TIMEOUT_MAX_ATTEMPTS = 2;

const MODEL_CALL_RETRY_BASE_DELAY_MS = 500;

export type RetryDecision =
  | { readonly retry: false }
  | { readonly retry: true; readonly delayMs: number };

export interface RetryQuestion {
  readonly attempt: number;
  readonly error: unknown;
}

export type RetryPolicy = Policy<RetryQuestion, RetryDecision>;

export const ALLOW_RETRY: RetryDecision = { delayMs: 0, retry: true };
export const STOP_RETRY: RetryDecision = { retry: false };

const retryLaw: Restriction<RetryDecision> = {
  meet: (a, b) =>
    !a.retry ? a : !b.retry ? b : { delayMs: Math.max(a.delayMs, b.delayMs), retry: true },
  open: ALLOW_RETRY,
};

const BUILT_IN: readonly RetryPolicy[] = [
  ({ error }) => (classifyModelCallError(error) === "retry" ? ALLOW_RETRY : STOP_RETRY),
  ({ attempt }) => (attempt < MODEL_CALL_MAX_ATTEMPTS ? ALLOW_RETRY : STOP_RETRY),
  ({ attempt, error }) =>
    attempt >= GATEWAY_STREAM_TIMEOUT_MAX_ATTEMPTS &&
    summarizeKnownError(error)?.id === "gateway-stream-timeout"
      ? STOP_RETRY
      : ALLOW_RETRY,
  ({ attempt }) => ({
    delayMs: MODEL_CALL_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 250),
    retry: true,
  }),
];

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
      throwIfSessionStreamDead(error);
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
      await delay(delayMs, signal);
    }
  }
}
