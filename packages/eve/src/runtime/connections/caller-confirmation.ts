/**
 * eve hands the caller's identity to a call only when the caller was the last person to speak as
 * the model made the call, or when the caller approved that call. After anyone else's message
 * joins the turn, a call that needs the caller's identity is refused until the caller speaks again.
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

const CALLER_IDENTITY = Symbol.for("eve.callerIdentity");

/** The running turn's caller. */
export function sessionCaller(): SessionAuthContext | null {
  return contextStorage.getStore()?.get(AuthKey) ?? null;
}

/**
 * Runs `fn` with the caller's identity available whoever spoke last, when `released`: for a call
 * the caller approved, and for listing a connection's tools, which runs nothing the model chose.
 */
export function withCallerIdentity<T>(released: boolean, fn: () => T): T {
  return released ? withContextScopeValue(CALLER_IDENTITY, true, fn) : fn();
}

/**
 * Throws unless the caller's identity may be handed out for `connectionName`: the caller spoke
 * last, or approved the running call. The failure reaches the model as the call's error, so its
 * message tells the model what to ask for.
 */
export function requireCallerConfirmation(
  connectionName: string,
  ctx: AlsContext | undefined,
): void {
  if (ctx === undefined) return;
  if (contextScopeValue<boolean>(CALLER_IDENTITY) === true) return;
  if (senderBesidesCaller(ctx) === undefined) return;
  throw new ConnectionAuthorizationFailedError(connectionName, {
    message: callerConfirmationMessage(`${connectionName} access`),
    reason: "confirmation_required",
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
