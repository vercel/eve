import type { PrincipalPolicy, SessionAuthContext } from "#channel/types.js";
import { AuthKey } from "#context/keys.js";
import type { TurnStepPayload } from "#execution/session/turn-step-types.js";

export const ANONYMOUS_PRINCIPAL = "anonymous";

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

export function resolveTurnPrincipal(
  payload: TurnStepPayload | undefined,
  serializedContext: Record<string, unknown>,
): string {
  const auth = payload?.delivery?.auth;
  if (auth !== undefined) return principalOf(auth);
  return principalOf(serializedContext[AuthKey.name] as SessionAuthContext | null | undefined);
}

export function continueTurnAuth<T extends SessionAuthContext | null | undefined>(
  turnAuth: T,
  auth: SessionAuthContext | null | undefined,
  policy?: PrincipalPolicy,
): T | SessionAuthContext | null {
  if (auth === undefined) return turnAuth;
  if (principalOf(auth) !== principalOf(turnAuth)) {
    if (policy === "retain") return turnAuth;
    throw new Error(
      "A message from another principal cannot join a running turn. Gate it with isSteeringDelivery so it waits for the turn to end.",
    );
  }
  return auth;
}

export function steeredByAfter(
  steeredBy: readonly SessionAuthContext[],
  caller: SessionAuthContext | null | undefined,
  sender: SessionAuthContext | null | undefined,
): readonly SessionAuthContext[] {
  if (sender === undefined || sender === null || principalOf(sender) === ANONYMOUS_PRINCIPAL) {
    return steeredBy;
  }
  if (principalOf(sender) === principalOf(caller)) return [];
  return steeredBy.some((person) => principalOf(person) === principalOf(sender))
    ? steeredBy
    : [...steeredBy, sender];
}
