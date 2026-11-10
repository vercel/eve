/**
 * eve hands the caller's identity to a call only when the caller was the last person to speak as
 * the model made the call, or when the caller approved that call. After anyone else's message
 * joins the turn, a call that needs the caller's identity is refused until the caller speaks again.
 * A call that waited on a person runs as it was asked, with the sender it had then.
 */

import type { SessionAuthContext } from "#channel/types.js";
import {
  contextScopeValue,
  contextStorage,
  withContextScopeValue,
  type AlsContext,
} from "#context/container.js";
import { AuthKey } from "#context/keys.js";
import { callerSpokeLast, readSender } from "#context/session-auth.js";
import { ConnectionAuthorizationFailedError } from "#connections/errors.js";

const CALLER_IDENTITY = Symbol.for("eve.callerIdentity");
const ASKED_SENDER = Symbol.for("eve.askedSender");

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

/** Whether the running call has the caller's identity whoever spoke last. */
export function hasCallerIdentity(): boolean {
  return contextScopeValue<boolean>(CALLER_IDENTITY) === true;
}

/**
 * Runs `fn` as a call the model made while `sender` had spoken last, whoever spoke since, as a
 * call that waited on a person runs. `undefined` leaves the turn's latest sender.
 */
export function withAskedSender<T>(sender: SessionAuthContext | null | undefined, fn: () => T): T {
  return sender === undefined ? fn() : withContextScopeValue(ASKED_SENDER, { sender }, fn);
}

/**
 * Who the running call reads as `auth.sender`: the caller for a call they approved, the sender a
 * waiting call was asked under, or else whoever spoke last in the turn.
 */
export function callSender(auth: {
  readonly current: SessionAuthContext | null;
  readonly sender: SessionAuthContext | null;
}): SessionAuthContext | null {
  if (hasCallerIdentity()) return auth.current;
  const asked = contextScopeValue<{ readonly sender: SessionAuthContext | null }>(ASKED_SENDER);
  return asked === undefined ? auth.sender : asked.sender;
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
  const current = ctx.get(AuthKey) ?? null;
  const sender = callSender({ current, sender: readSender(ctx, current) });
  if (callerSpokeLast({ current, sender })) return;
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
