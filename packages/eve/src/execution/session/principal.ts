import type { SessionAuthContext } from "#channel/types.js";

/** Every anonymous caller shares this one principal. */
export const ANONYMOUS_PRINCIPAL = "anonymous";

/**
 * Stable key for the principal a session identity acts as: only a turn's own
 * principal steers it, and one principal's queued messages share a turn.
 */
export function principalOf(auth: SessionAuthContext | null | undefined): string {
  if (auth === null || auth === undefined || auth.principalType === "anonymous") {
    return ANONYMOUS_PRINCIPAL;
  }
  return JSON.stringify([
    auth.authenticator,
    auth.issuer ?? null,
    auth.principalType,
    auth.principalId,
  ]);
}
