import type { SessionCallbackPayload } from "#channel/session-callback.js";

const SESSION_CALLBACK_TIMEOUT_MS = 30_000;

/**
 * POSTs one {@link SessionCallbackPayload} to a caller's callback URL.
 *
 * Shared by the terminal callback step and notification forwarding so
 * every callback POST carries the same transport guards. Throws on any
 * non-2xx response; callers decide whether delivery is best-effort
 * (notifications) or part of the durable result path (termination).
 */
export async function postSessionCallback(input: {
  readonly payload: SessionCallbackPayload;
  readonly url: string;
}): Promise<void> {
  const response = await fetch(input.url, {
    body: JSON.stringify(input.payload),
    headers: {
      "content-type": "application/json",
    },
    method: "POST",
    // Do not follow redirects: a validated callback host could otherwise
    // 3xx-bounce the framework to an internal/metadata address after the
    // path/token check has already passed.
    redirect: "error",
    signal: AbortSignal.timeout(SESSION_CALLBACK_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Session callback failed with HTTP ${response.status}.`);
  }
}
