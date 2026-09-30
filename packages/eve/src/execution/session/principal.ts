import type { SessionAuthContext } from "#channel/types.js";
import { AuthKey } from "#context/keys.js";
import type { TurnStepPayload } from "#execution/session/turn-step-types.js";

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

/**
 * The principal of the delivery that starts or continues a turn. A delivery
 * without auth keeps the session's current identity, as the turn step does.
 */
export function resolveTurnPrincipal(
  payload: TurnStepPayload | undefined,
  serializedContext: Record<string, unknown>,
): string {
  const auth = payload?.delivery?.auth;
  if (auth !== undefined) return principalOf(auth);
  return principalOf(serializedContext[AuthKey.name] as SessionAuthContext | null | undefined);
}
