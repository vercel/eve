/**
 * Rule 3 of multiplayer sessions: eve hands out the caller's credentials without asking only
 * while the caller is the last person to have spoken. After anyone else's message joins the turn,
 * the caller's token is released only for a call the caller confirmed: one they approved, or one
 * a mismatch helper cleared from their remembered approval.
 */

import type { SessionAuthContext } from "#channel/types.js";
import {
  contextScopeValue,
  contextStorage,
  withContextScopeValue,
  type AlsContext,
} from "#context/container.js";
import { AuthKey } from "#context/keys.js";
import { readSender } from "#context/sender.js";
import { ConnectionAuthorizationFailedError } from "#connections/errors.js";
import { principalOf } from "#execution/session/principal.js";

const CALLER_CONFIRMED = Symbol.for("eve.callerConfirmed");

/** Runs one call's effect, marked as confirmed by the caller when `confirmed`. */
export function withCallerConfirmation<T>(confirmed: boolean, fn: () => T): T {
  return confirmed ? withContextScopeValue(CALLER_CONFIRMED, true, fn) : fn();
}

/**
 * Whether the person who approved a call is its caller: no response policy named a responder, so
 * the requester answered, or the one it named is the caller.
 */
export function approvedByCaller(responder: SessionAuthContext | undefined): boolean {
  if (responder === undefined) return true;
  return principalOf(responder) === principalOf(contextStorage.getStore()?.get(AuthKey));
}

/** Whether the caller is the last to have spoken in the turn `ctx` runs. */
export function callerSpokeLast(auth: {
  readonly current: SessionAuthContext | null | undefined;
  readonly sender: SessionAuthContext | null | undefined;
}): boolean {
  return principalOf(auth.current) === principalOf(auth.sender);
}

/**
 * Throws unless the caller's token may be handed out for `connectionName`: the caller spoke
 * last, or confirmed the running call. The failure reaches the model as the call's error, so its
 * message tells the model what to ask for.
 */
export function requireCallerConfirmation(
  connectionName: string,
  ctx: AlsContext | undefined,
): void {
  if (ctx === undefined) return;
  const current = ctx.get(AuthKey) ?? null;
  if (callerSpokeLast({ current, sender: readSender(ctx, current) })) return;
  if (contextScopeValue<boolean>(CALLER_CONFIRMED) === true) return;
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
    `Another person spoke after the person who started this request, so using that person's ` +
    `${what} needs their confirmation. Ask the person who started this request to clearly ` +
    `confirm this action. Retry only after a reply from them that plainly confirms it. If their ` +
    `reply is unclear or about something else, ask again instead of retrying.`
  );
}
