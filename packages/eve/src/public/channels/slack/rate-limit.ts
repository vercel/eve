/**
 * Outbound Slack rate-limit handling.
 *
 * Slack answers a throttled Web API call with HTTP 429 and a
 * `Retry-After` header, and the vendored call primitive turns any
 * non-2xx into a thrown `SlackApiError`. Without this wrapper a single
 * 429 mid-turn aborts whatever the channel was doing — dropping a
 * streamed `chat.update`, or truncating the `conversations.replies`
 * paging loop — even though Slack asked only that we wait a moment.
 *
 * The retry lives in the fetch the transport hands the primitive rather
 * than around each call site: every outbound leg the channel drives
 * (Web API methods, the raw bytes POST of the file-upload handshake,
 * authenticated `url_private` downloads) goes through that one fetch,
 * and the primitive is vendored from an upstream package so it cannot
 * carry the behavior itself.
 *
 * Only 429 is retried. Slack rejects a rate-limited call without
 * processing it, so replaying it is safe. A 5xx is not: `chat.postMessage`
 * may well have succeeded with the response lost on the way back, and a
 * replay would post the message twice.
 */

import { createLogger } from "#internal/logging.js";

const log = createLogger("slack.rate-limit");

/**
 * Total attempts per request, the first included. Slack's own guidance is
 * to back off and retry; two retries covers the burst that a streamed turn
 * provokes against a Tier 3 method without holding a request handler open
 * indefinitely.
 */
const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Wait used when a 429 carries no usable `Retry-After`. Slack always sends
 * one, so this only covers a proxy or simulator that does not.
 */
const DEFAULT_RETRY_DELAY_MS = 1_000;

/**
 * Longest single wait honored. Slack's advice is authoritative but
 * unbounded, and a minute-long sleep inside a turn is worse than
 * surfacing the rate limit: past this the call fails as it does today.
 */
const MAX_RETRY_DELAY_MS = 30_000;

/** Test seams. Not part of the channel's public configuration surface. */
export interface SlackRateLimitRetryOptions {
  readonly maxAttempts?: number;
  readonly maxDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Wraps a fetch implementation so Slack 429 responses are retried after
 * the delay Slack asks for, up to a bounded number of attempts. The final
 * response is returned as-is — exhausted retries surface exactly the
 * error the caller would have seen without the wrapper.
 *
 * `undefined` wraps the global fetch.
 */
export function withSlackRateLimitRetry(
  fetchImpl: typeof globalThis.fetch | undefined,
  options?: SlackRateLimitRetryOptions,
): typeof globalThis.fetch {
  const maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const maxDelayMs = options?.maxDelayMs ?? MAX_RETRY_DELAY_MS;
  const sleep = options?.sleep ?? defaultSleep;

  return async (input, init) => {
    for (let attempt = 1; ; attempt += 1) {
      // `globalThis.fetch` is read per request, not captured, so a test
      // that stubs it after the channel was built still sees its stub.
      const response = await (fetchImpl ?? globalThis.fetch)(input, init);
      if (response.status !== 429 || attempt >= maxAttempts) return response;

      const delayMs = resolveRetryDelayMs(response.headers.get("retry-after"));
      if (delayMs === undefined || delayMs > maxDelayMs) return response;

      // The retried response is never read, and an undrained body holds
      // its connection open until the agent process exits.
      await discardBody(response);
      log.warn("Slack rate limited the request; retrying", {
        attempt,
        delayMs,
        maxAttempts,
        method: describeRequest(input),
      });
      await sleep(delayMs);
    }
  };
}

/**
 * Parses `Retry-After` as Slack sends it — delay in whole seconds. The
 * HTTP-date form is not accepted: Slack does not use it, and a clock skew
 * between the agent and Slack would turn it into an arbitrary sleep.
 * `undefined` means "no usable advice", which the caller treats as a
 * reason to stop rather than to guess.
 */
function resolveRetryDelayMs(header: string | null): number | undefined {
  if (header === null) return DEFAULT_RETRY_DELAY_MS;
  const seconds = Number(header.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.ceil(seconds * 1_000);
}

/**
 * Slack method name for the log line, recovered from the request URL. The
 * wrapper sits below the layer that knows it, and the last path segment is
 * exactly the method for a Web API call.
 */
function describeRequest(input: Parameters<typeof globalThis.fetch>[0]): string {
  const url = input instanceof Request ? input.url : input.toString();
  try {
    const { pathname } = new URL(url);
    return pathname.slice(pathname.lastIndexOf("/") + 1) || pathname;
  } catch {
    return url;
  }
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A body that cannot be cancelled is already unusable; the retry
    // matters more than reclaiming the connection.
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
