import { setTimeout as delay } from "node:timers/promises";

import { createLogger } from "#internal/logging.js";
import { classifyModelCallError } from "#harness/model-call/errors.js";
import { summarizeKnownError } from "#harness/semantic-errors/index.js";
import { throwIfSessionStreamDead } from "#harness/session-stream-write-error.js";
import { walkCauseChain } from "#shared/errors.js";
import { isObject } from "#shared/guards.js";
import { decide, type Policy, type Restriction } from "#shared/restriction.js";

const log = createLogger("harness.tool-loop");
const MODEL_CALL_MAX_ATTEMPTS = 5;

const GATEWAY_STREAM_TIMEOUT_MAX_ATTEMPTS = 2;

const MODEL_CALL_RETRY_BASE_DELAY_MS = 500;
const MODEL_CALL_RETRY_MAX_DELAY_MS = 30_000;

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
  ({ attempt, error }) => {
    const backoff = Math.min(
      MODEL_CALL_RETRY_MAX_DELAY_MS,
      MODEL_CALL_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 250),
    );
    const retryAfter = extractRetryAfterMs(error);
    return {
      delayMs:
        retryAfter !== undefined
          ? Math.min(MODEL_CALL_RETRY_MAX_DELAY_MS, Math.max(backoff, retryAfter))
          : backoff,
      retry: true,
    };
  },
];

function extractRetryAfterMs(error: unknown): number | undefined {
  for (const candidate of walkCauseChain(error)) {
    if (!isObject(candidate)) continue;
    const headers = candidate.responseHeaders;
    if (!isObject(headers)) continue;
    const msHeader = readHeader(headers, "retry-after-ms");
    if (msHeader !== undefined) {
      const parsed = Number(msHeader);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    const secHeader = readHeader(headers, "retry-after");
    if (secHeader !== undefined) {
      const seconds = Number(secHeader);
      if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1_000);
      const timestamp = Date.parse(secHeader);
      if (Number.isFinite(timestamp)) {
        const delta = timestamp - Date.now();
        if (delta > 0) return delta;
      }
    }
  }
  return undefined;
}

function readHeader(headers: Record<string, unknown>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

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
      await delay(delayMs, undefined, { signal });
    }
  }
}
