import { createGateway } from "ai";

import { toErrorMessage } from "#shared/errors.js";

/**
 * Detects the gateway's "this key is not authorized" failure structurally, by a
 * 401 or `authentication_error`, without importing the error class. `ai`
 * re-exports `createGateway` but not the gateway error types.
 */
function isGatewayAuthRejection(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { type?: unknown; name?: unknown; statusCode?: unknown };
  return (
    candidate.type === "authentication_error" ||
    candidate.name === "GatewayAuthenticationError" ||
    candidate.statusCode === 401
  );
}

/** How long to wait for the gateway before treating the check as inconclusive. */
const VALIDATION_TIMEOUT_MS = 10_000;

/**
 * Outcome of round-tripping an `AI_GATEWAY_API_KEY` against the Vercel AI
 * Gateway.
 *
 * - `valid`: the gateway accepted the key.
 * - `invalid`: the gateway rejected the key (authentication failure).
 * - `inconclusive`: the check itself failed (offline, timeout). The caller can
 *   save the key anyway rather than block on a flaky network. Only an explicit
 *   rejection counts as a wrong key.
 */
export type GatewayKeyValidation =
  | { kind: "valid" }
  | { kind: "invalid"; message: string }
  | { kind: "inconclusive"; message: string };

/**
 * Confirms an `AI_GATEWAY_API_KEY` authenticates before eve saves it, by making
 * one account-scoped request to the gateway (`getCredits`). That endpoint
 * rejects a bad key with a 401; the model catalog (`getAvailableModels`) is
 * public and would accept any key, so it cannot validate.
 *
 * Aborts with the caller's `signal` (so the dev TUI's Esc/Ctrl-C interrupt
 * cancels it like any other loading state); a user-initiated abort is rethrown,
 * while a timeout or network failure resolves to `inconclusive`.
 */
export async function validateGatewayApiKey(
  apiKey: string,
  signal?: AbortSignal,
): Promise<GatewayKeyValidation> {
  const timeout = AbortSignal.timeout(VALIDATION_TIMEOUT_MS);
  const effectiveSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  try {
    const provider = createGateway({
      apiKey,
      fetch: (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        globalThis.fetch(url, { ...init, signal: effectiveSignal }),
    });
    await provider.getCredits();
    return { kind: "valid" };
  } catch (error) {
    // A user-initiated abort is not a verdict on the key, so let it propagate
    // and unwind the flow the way other loading states do.
    if (signal?.aborted === true) throw error;
    if (isGatewayAuthRejection(error)) {
      return { kind: "invalid", message: "The AI Gateway rejected this key." };
    }
    return { kind: "inconclusive", message: toErrorMessage(error) };
  }
}
