import type { PrincipalPolicy, SessionAuthContext } from "#channel/types.js";
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

/**
 * The identity a running turn continues under once a message sent as `auth`
 * joins it. Within a turn the principal is fixed and only its claims may
 * update; input without auth acts as the turn's identity. Another principal
 * joins only with a join policy: `"retain-caller"` leaves the turn under its
 * caller, `"adopt-sender"` hands the turn to the sender. Anyone else's answers
 * settle requests as their responder without joining the turn.
 */
export function continueTurnAuth<T extends SessionAuthContext | null | undefined>(
  turnAuth: T,
  auth: SessionAuthContext | null | undefined,
  policy?: PrincipalPolicy,
): T | SessionAuthContext | null {
  if (auth === undefined) return turnAuth;
  if (principalOf(auth) !== principalOf(turnAuth)) {
    if (policy === "retain-caller") return turnAuth;
    if (policy === "adopt-sender") return auth;
    throw new Error(
      "A message from another principal cannot join a running turn. Gate it with isSteeringDelivery so it waits for the turn to end.",
    );
  }
  return auth;
}

/**
 * The turn's `steeredBy` once a message sent as `sender` joins it: the caller's own message
 * clears the list, and anyone else's adds them once. A message without auth acts as the caller.
 */
export function steeredByAfter(
  steeredBy: readonly SessionAuthContext[],
  caller: SessionAuthContext | null | undefined,
  sender: SessionAuthContext | null | undefined,
): readonly SessionAuthContext[] {
  if (sender === undefined || sender === null || principalOf(sender) === principalOf(caller)) {
    return [];
  }
  return steeredBy.some((person) => principalOf(person) === principalOf(sender))
    ? steeredBy
    : [...steeredBy, sender];
}
