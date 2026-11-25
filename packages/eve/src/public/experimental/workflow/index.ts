import { experimental_rateLimit } from "#compiled/@workflow/core/index.js";
import { RateLimitMaxWaitError as SdkRateLimitMaxWaitError } from "#compiled/@workflow/errors/index.js";

/** Options for {@link rateLimit}. */
export interface RateLimitOptions {
  /** Shared key identifying the rate limit across runs (1 character to 512 UTF-8 bytes; `$` prefix is reserved). */
  readonly key: string;
  /** Maximum calls admitted per {@link period}. */
  readonly limit: number;
  /** Window for {@link limit}: a duration string such as `"1s"`, `"1m"`, or `"1h"`, or milliseconds (at most 24 hours). */
  readonly period: string | number;
  /** Longest time to wait for a slot before rejecting with {@link RateLimitMaxWaitError} (at most 30 days). */
  readonly maxWait?: string | number;
  /** Calls an idle key admits at once before refilling at one per `period / limit` (defaults to `1`). */
  readonly burst?: number;
}

/** Thrown by {@link rateLimit} when the next available slot exceeds `maxWait`. */
export interface RateLimitMaxWaitError extends Error {
  /** Rate limit key that had no slot within `maxWait`. */
  readonly key: string;
  /** When the call would have gone ahead if it had waited. */
  readonly wouldAcquireAt?: Date;
}

/**
 * Waits for a slot under a rate limit shared across every run of the agent.
 *
 * Call inside a `"use workflow"` function on a spec 10 run. Rejects with
 * {@link RateLimitMaxWaitError} without consuming capacity when the next slot
 * exceeds `maxWait`.
 */
export const rateLimit = experimental_rateLimit as (options: RateLimitOptions) => Promise<void>;

/** Error thrown by {@link rateLimit} when no slot is available within `maxWait`. */
export const RateLimitMaxWaitError: {
  new (key: string, wouldAcquireAt?: Date): RateLimitMaxWaitError;
  is(value: unknown): value is RateLimitMaxWaitError;
  readonly prototype: RateLimitMaxWaitError;
} = SdkRateLimitMaxWaitError;
