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

const CALL_IDENTITY = Symbol.for("eve.callIdentity");
const ASKED_SENDER = Symbol.for("eve.askedSender");
const IDENTITY_REQUEST = Symbol.for("eve.identityRequest");

/** Whose identity the running call has, whoever spoke last. */
interface CallIdentity {
  /** The people who approved the call, by `principalOf`. */
  readonly confirmed: ReadonlySet<string>;
  /** With `callerConfirmation: "once"`, the caller already approved calls after the last speaker. */
  readonly once?: boolean;
}

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
 * Runs `fn` as a call `confirmed` approved, each of whom it may act as whoever spoke last. `once`
 * releases the caller's identity, unasked, with `callerConfirmation: "once"`; unlike the caller's
 * own approval, it doesn't make the call read the caller as `auth.sender`.
 */
export function withCallIdentity<T>(
  identity: { readonly confirmed: readonly SessionPerson[]; readonly once?: boolean },
  fn: () => T,
): T {
  if (identity.confirmed.length === 0 && identity.once !== true) return fn();
  const value: CallIdentity = {
    confirmed: new Set(identity.confirmed.map((person) => principalOf(personAuth(person)))),
    ...(identity.once === true && { once: true }),
  };
  return withContextScopeValue(CALL_IDENTITY, value, fn);
}

/**
 * Runs `fn` with the caller's identity available whoever spoke last, when `released`: for listing
 * a connection's tools, which runs nothing the model chose.
 */
export function withCallerIdentity<T>(released: boolean, fn: () => T): T {
  const caller = sessionCaller();
  return released && caller !== null
    ? withCallIdentity({ confirmed: [personOf(caller)] }, fn)
    : fn();
}

function callIdentity(): CallIdentity | undefined {
  return contextScopeValue<CallIdentity>(CALL_IDENTITY);
}

/** Whether `person` approved the running call. */
function approvedBy(person: SessionAuthContext | null): boolean {
  return person !== null && callIdentity()?.confirmed.has(principalOf(person)) === true;
}

/**
 * Whether the caller's identity is released for the running call whoever spoke last: the caller
 * approved it, the caller already approved calls after this speaker under `"once"`, or the
 * agent's `callerConfirmation` is `"never"`.
 */
function callerReleased(ctx: AlsContext | undefined, current: SessionAuthContext | null): boolean {
  return (
    approvedBy(current) || callIdentity()?.once === true || callerConfirmation(ctx) === "never"
  );
}

/**
 * Whether work may act as the caller: they spoke last, or their identity is released for the
 * running call. `openCodeChannel()` reads this, since it opens a session as the caller.
 */
export function callerIdentityAvailable(auth: {
  readonly current: SessionAuthContext | null | undefined;
  readonly sender: SessionAuthContext | null | undefined;
}): boolean {
  return callerSpokeLast(auth) || callerReleased(contextStorage.getStore(), auth.current ?? null);
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
 * Who the running call reads as `auth.sender`: the caller for a call the caller approved, the
 * sender a waiting call was asked under, or else whoever spoke last in the turn.
 */
export function callSender(auth: {
  readonly current: SessionAuthContext | null;
  readonly sender: SessionAuthContext | null;
}): SessionAuthContext | null {
  if (approvedBy(auth.current)) return auth.current;
  const asked = contextScopeValue<{ readonly sender: SessionAuthContext | null }>(ASKED_SENDER);
  return asked === undefined ? auth.sender : asked.sender;
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
  const key = onceKey(current, spokeLast(ctx, current));
  return key !== undefined && memory.remembered[key]?.outcome === "accepted";
}

/**
 * Where `"once"` remembers that the caller approved a call after `sender` spoke. Every anonymous
 * person shares one identity, so nothing is remembered for one: each call asks.
 */
function onceKey(
  caller: SessionAuthContext | null,
  sender: SessionAuthContext | null,
): string | undefined {
  if (sender === null || sender.principalType === "anonymous") return undefined;
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
  return isConnectionAuthorizationFailedError(error) && error.reason === "confirmation_required"
    ? (error as { [IDENTITY_REQUEST]?: IdentityRequest })[IDENTITY_REQUEST]
    : undefined;
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
  const sender = spokeLast(ctx, current);
  if (callerSpokeLast({ current, sender }) || callerReleased(ctx, current)) return;
  const askable = current !== null && current.principalType !== "anonymous";
  const remember = callerConfirmation(ctx) === "once" ? onceKey(current, sender) : undefined;
  throw confirmationRequired(
    connectionName,
    callerConfirmationMessage(`${connectionName} access`),
    askable
      ? {
          person: personOf(current),
          ...(remember !== undefined && { remember: { key: remember } }),
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
  const named = personAuth(person);
  if (approvedBy(named)) return;
  if (principalOf(spokeLast(ctx, ctx?.get(AuthKey) ?? null)) === principalOf(named)) return;
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
