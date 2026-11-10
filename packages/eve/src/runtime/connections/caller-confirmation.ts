/**
 * eve hands a person's identity to a call only when they were the last person to speak as the
 * model made the call, or when they approved that call. After anyone else's message joins the
 * turn, a call that needs the caller's identity stops: eve asks the caller to approve it where the
 * session can ask, and refuses it otherwise. A call that waited on a person runs as it was asked,
 * with the sender it had then.
 */

import type { ApprovalMemory, RememberRequest } from "#approval/evaluation.js";
import type { SessionAuthContext } from "#channel/types.js";
import {
  contextScopeValue,
  contextStorage,
  withContextScopeValue,
  type AlsContext,
} from "#context/container.js";
import { AuthKey } from "#context/keys.js";
import {
  callerSpokeLast,
  personAuth,
  personOf,
  principalOf,
  readSender,
  type SessionPerson,
} from "#context/session-auth.js";
import {
  ConnectionAuthorizationFailedError,
  isConnectionAuthorizationFailedError,
} from "#connections/errors.js";
import { resolveCallerConfirmation } from "#execution/effective-agent-config.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import type { CallerConfirmation } from "#shared/agent-definition.js";

const CALLER_IDENTITY = Symbol.for("eve.callerIdentity");
const ASKED_SENDER = Symbol.for("eve.askedSender");
const CONFIRMED_BY = Symbol.for("eve.confirmedBy");
const IDENTITY_REQUEST = Symbol.for("eve.identityRequest");
/** How far down an error's causes eve looks for the identity a refusal needs. */
const MAX_CAUSE_DEPTH = 5;

/** The running turn's caller. */
export function sessionCaller(): SessionAuthContext | null {
  return contextStorage.getStore()?.get(AuthKey) ?? null;
}

/** The agent's `callerConfirmation`: the root agent's, also in a local subagent's session. */
export function callerConfirmation(
  ctx: AlsContext | undefined = contextStorage.getStore(),
): CallerConfirmation {
  return resolveCallerConfirmation(ctx?.get(BundleKey));
}

/**
 * Runs `fn` with the caller's identity available whoever spoke last, when `released`: for a call
 * the caller approved, and for listing a connection's tools, which runs nothing the model chose.
 */
export function withCallerIdentity<T>(released: boolean, fn: () => T): T {
  return released ? withContextScopeValue(CALLER_IDENTITY, true, fn) : fn();
}

/**
 * Whether the running call has the caller's identity whoever spoke last: the caller approved it,
 * or the agent's `callerConfirmation` is `"never"`.
 */
export function hasCallerIdentity(
  ctx: AlsContext | undefined = contextStorage.getStore(),
): boolean {
  return (
    contextScopeValue<boolean>(CALLER_IDENTITY) === true || callerConfirmation(ctx) === "never"
  );
}

/**
 * Whether work may use the caller's identity: the caller spoke last, approved the running call,
 * or the agent never asks. eve's own role checks read this beside `auth.current`.
 */
export function callerIdentityAvailable(auth: {
  readonly current: SessionAuthContext | null | undefined;
  readonly sender: SessionAuthContext | null | undefined;
}): boolean {
  return hasCallerIdentity() || callerSpokeLast(auth);
}

/**
 * Runs `fn` as a call the model made while `sender` had spoken last, whoever spoke since, as a
 * call that waited on a person runs. `undefined` leaves the turn's latest sender.
 */
export function withAskedSender<T>(sender: SessionAuthContext | null | undefined, fn: () => T): T {
  return sender === undefined ? fn() : withContextScopeValue(ASKED_SENDER, { sender }, fn);
}

/** Who had spoken last as the model made the running call, whoever approved it. */
function spokeLast(
  ctx: AlsContext | undefined,
  current: SessionAuthContext | null,
): SessionAuthContext | null {
  const asked = contextScopeValue<{ readonly sender: SessionAuthContext | null }>(ASKED_SENDER);
  return asked === undefined ? readSender(ctx, current) : asked.sender;
}

/**
 * Who the running call reads as `auth.sender`: the caller for a call with their identity, the
 * sender a waiting call was asked under, or else whoever spoke last in the turn.
 */
export function callSender(auth: {
  readonly current: SessionAuthContext | null;
  readonly sender: SessionAuthContext | null;
}): SessionAuthContext | null {
  if (hasCallerIdentity()) return auth.current;
  const asked = contextScopeValue<{ readonly sender: SessionAuthContext | null }>(ASKED_SENDER);
  return asked === undefined ? auth.sender : asked.sender;
}

/** Runs `fn` as a call `person` approved: it may use their identity, whoever spoke last. */
export function withConfirmedPerson<T>(person: SessionPerson | undefined, fn: () => T): T {
  return person === undefined ? fn() : withContextScopeValue(CONFIRMED_BY, person, fn);
}

/**
 * Whether, with `callerConfirmation: "once"`, the caller already approved a call after the person
 * who spoke last, so the running call has the caller's identity without asking.
 */
export function confirmedOnce(
  memory: ApprovalMemory | undefined,
  ctx: AlsContext | undefined = contextStorage.getStore(),
): boolean {
  if (memory === undefined || ctx === undefined || callerConfirmation(ctx) !== "once") return false;
  const current = ctx.get(AuthKey) ?? null;
  return memory.remembered[onceKey(current, spokeLast(ctx, current))]?.outcome === "accepted";
}

/** Where `"once"` remembers that the caller approved a call after `sender` spoke. */
function onceKey(caller: SessionAuthContext | null, sender: SessionAuthContext | null): string {
  return JSON.stringify(["eve.callerConfirmation", principalOf(caller), principalOf(sender)]);
}

/** What eve asks for when a call stopped for a person's identity. */
export interface IdentityRequest {
  /** Whose identity the call needs. Only they can approve it. */
  readonly person: SessionPerson;
  /** Where the caller's approval is remembered, with `callerConfirmation: "once"`. */
  readonly remember?: RememberRequest;
}

/** The identity request a refusal carries, if the call can wait for one. */
export function identityRequestOf(error: unknown): IdentityRequest | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth++) {
    if (isConnectionAuthorizationFailedError(current) && current.reason === "confirmation_required")
      return (current as { [IDENTITY_REQUEST]?: IdentityRequest })[IDENTITY_REQUEST];
    current = current.cause;
  }
  return undefined;
}

function confirmationRequired(
  connectionName: string,
  message: string,
  request: IdentityRequest | undefined,
): ConnectionAuthorizationFailedError {
  const error = new ConnectionAuthorizationFailedError(connectionName, {
    message,
    reason: "confirmation_required",
    retryable: false,
  });
  // Off the enumerable fields, so it never reaches a result or a log as part of the error.
  if (request !== undefined) Object.defineProperty(error, IDENTITY_REQUEST, { value: request });
  return error;
}

/**
 * Throws unless the caller's identity may be handed out for `connectionName`: the caller spoke
 * last, or approved the running call. The refusal names the caller, so the session can ask them;
 * where it can't, its message reaches the model as the call's error and tells it what to ask for.
 */
export function requireCallerConfirmation(
  connectionName: string,
  ctx: AlsContext | undefined,
): void {
  if (ctx === undefined) return;
  const current = ctx.get(AuthKey) ?? null;
  const sender = callSender({ current, sender: readSender(ctx, current) });
  if (callerSpokeLast({ current, sender })) return;
  const askable = current !== null && current.principalType !== "anonymous";
  throw confirmationRequired(
    connectionName,
    callerConfirmationMessage(`${connectionName} access`),
    askable
      ? {
          person: personOf(current),
          ...(callerConfirmation(ctx) === "once" && {
            remember: { key: onceKey(current, sender) },
          }),
        }
      : undefined,
  );
}

/**
 * Throws unless the running call may use `person`'s identity for `connectionName`: they sent the
 * message the model read last as it made the call, or approved the call. `callerConfirmation`
 * doesn't apply: the identity of someone who isn't the caller always needs them.
 */
export function requirePersonConfirmation(
  person: SessionPerson,
  connectionName: string,
  ctx: AlsContext | undefined,
): void {
  const key = principalOf(personAuth(person));
  const confirmed = contextScopeValue<SessionPerson>(CONFIRMED_BY);
  if (confirmed !== undefined && principalOf(personAuth(confirmed)) === key) return;
  if (principalOf(spokeLast(ctx, ctx?.get(AuthKey) ?? null)) === key) return;
  throw confirmationRequired(
    connectionName,
    `${person.principalId} didn't send the latest message and hasn't approved this action, so it ` +
      `can't use their ${connectionName} access. Ask ${person.principalId} to clearly confirm ` +
      `this action. Retry only after a reply from them that plainly confirms it.`,
    { person },
  );
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
