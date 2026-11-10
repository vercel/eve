import type { SessionAuthContext } from "#channel/types.js";
import type { AlsContext } from "#context/container.js";
import { AuthKey, SenderAuthKey } from "#context/keys.js";
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
 * joins it. Within a turn the caller is fixed: their own message may update
 * only their claims, and anyone else's message leaves the caller as it was.
 * Input without auth acts as the turn's identity.
 */
export function continueTurnAuth<T extends SessionAuthContext | null | undefined>(
  turnAuth: T,
  auth: SessionAuthContext | null | undefined,
): T | SessionAuthContext | null {
  if (auth === undefined || principalOf(auth) !== principalOf(turnAuth)) return turnAuth;
  return auth;
}

/**
 * Records who spoke last once input sent as `auth` joins the turn: the seed is
 * unset while that is the caller, and holds the person otherwise. Input without
 * auth acts as the turn's identity and changes nothing.
 */
export function recordSender(
  ctx: Pick<AlsContext, "delete" | "set">,
  turnAuth: SessionAuthContext | null | undefined,
  auth: SessionAuthContext | null | undefined,
): void {
  if (auth === undefined) return;
  if (principalOf(auth) === principalOf(turnAuth)) ctx.delete(SenderAuthKey);
  else ctx.set(SenderAuthKey, auth);
}
