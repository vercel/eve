import type { SessionAuthContext } from "#channel/types.js";
import { AuthKey } from "#context/keys.js";
import { readAnswerer } from "#execution/session/answerer.js";
import type { SessionStateCursor } from "#execution/session/state-cursor.js";
import type { TurnStepPayload } from "#execution/session/turn-step-types.js";

/**
 * The principal a turn acts for, as `turnStep` decides it: the auth of the
 * delivery that starts it, else the session's current principal. A person's
 * answer to a request the session waits on never changes its principal (see
 * `readAnswerer`), and an authorization resume carries the principal of the
 * turn that parked (see `authorizationResumeDelivery`).
 */
export function turnPrincipal(
  payload: TurnStepPayload | undefined,
  cursor: SessionStateCursor,
): SessionAuthContext | null {
  const delivery = payload?.delivery;
  const { serializedContext } = cursor;
  const context = {
    has: (key: { readonly name: string }) => serializedContext[key.name] !== undefined,
  };
  const state = cursor.sessionState.snapshot.session.state;
  if (delivery?.auth !== undefined && readAnswerer(context, delivery, state) === undefined) {
    return delivery.auth;
  }
  return sessionPrincipal(serializedContext);
}

/** The principal the session acts for now: its last turn's. */
export function sessionPrincipal(
  serializedContext: Record<string, unknown>,
): SessionAuthContext | null {
  return (serializedContext[AuthKey.name] as SessionAuthContext | null | undefined) ?? null;
}
