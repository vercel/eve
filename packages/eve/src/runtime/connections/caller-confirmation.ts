/**
 * eve hands out the caller's credentials without asking only while the caller is the last person
 * to have spoken in the turn. After anyone else's message joins it, the caller's token is released
 * only for a call the caller confirmed: one they approved, or one a mismatch helper cleared from
 * their remembered approval.
 */

import type { SessionAuthContext } from "#channel/types.js";
import {
  contextScopeValue,
  contextStorage,
  withContextScopeValue,
  type AlsContext,
} from "#context/container.js";
import { AuthKey } from "#context/keys.js";
import { senderBesidesCaller } from "#context/session-auth.js";
import { ConnectionAuthorizationFailedError } from "#connections/errors.js";

/**
 * What one call does with the caller's token, decided before it runs: `"release"` hands it out
 * whoever spoke last, and `"withhold"` refuses it whoever spoke last.
 */
export type CallerToken = "release" | "withhold";

const CALLER_TOKEN = Symbol.for("eve.callerToken");

/** The running turn's caller. */
export function sessionCaller(): SessionAuthContext | null {
  return contextStorage.getStore()?.get(AuthKey) ?? null;
}

/** Runs one call's effect with its caller-token decision; `undefined` leaves it to who spoke last. */
export function withCallerToken<T>(token: CallerToken | undefined, fn: () => T): T {
  return token === undefined ? fn() : withContextScopeValue(CALLER_TOKEN, token, fn);
}

/**
 * Throws unless the caller's token may be handed out for `connectionName`: the running call
 * releases it, or the caller spoke last. The failure reaches the model as the call's error, so its
 * message tells the model what to ask for.
 */
export function requireCallerConfirmation(
  connectionName: string,
  ctx: AlsContext | undefined,
): void {
  if (ctx === undefined) return;
  const token = contextScopeValue<CallerToken>(CALLER_TOKEN);
  if (token === "release") return;
  if (token === undefined && senderBesidesCaller(ctx) === undefined) return;
  throw new ConnectionAuthorizationFailedError(connectionName, {
    message: callerConfirmationMessage(`${connectionName} access`),
    reason: "caller_confirmation_required",
    retryable: false,
  });
}

/**
 * What the model reads when the caller's `what` was refused: who to ask, and that only a reply
 * that plainly confirms the action counts.
 */
export function callerConfirmationMessage(what: string): string {
  return (
    `Someone else has spoken since the person whose message started this turn, so this action ` +
    `can't use their ${what} until they confirm it. Ask the person whose message started this ` +
    `turn to clearly confirm this action. Retry only after a reply from them that plainly ` +
    `confirms it. If their reply is unclear or about something else, ask again instead of retrying.`
  );
}
