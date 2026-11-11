/**
 * eve hands a person's identity to a call only when they were the last person to speak as the
 * model made the call, or when they approved that call. After anyone else's message joins the
 * turn, a call that needs the caller's identity stops: eve asks the caller to approve it where the
 * session can ask, and refuses it otherwise. The caller's approval also covers their later calls
 * until someone else speaks again. A call that waited on a person runs as it was asked, with the
 * sender it had then.
 */

import type { ApprovalMemory, RememberRequest } from "#approval/evaluation.js";
import type { SessionAuthContext } from "#channel/types.js";
import {
  contextScopeValue,
  contextStorage,
  withContextScopeValue,
  type AlsContext,
} from "#context/container.js";
import { AuthKey, DelegatedIdentityKey } from "#context/keys.js";
import {
  callerSpokeLast,
  personOf,
  principalOf,
  readSender,
  type SessionPerson,
} from "#context/session-auth.js";
import {
  ConnectionAuthorizationFailedError,
  isConnectionAuthorizationFailedError,
} from "#connections/errors.js";

const CALL_IDENTITY = Symbol.for("eve.callIdentity");
const ASKED_SENDER = Symbol.for("eve.askedSender");
const IDENTITY_REQUEST = Symbol.for("eve.identityRequest");

/** Whose identity the running call has, whoever spoke last. */
interface CallIdentity {
  readonly confirmed: ReadonlySet<string>;
  readonly remembered: ReadonlySet<string>;
  readonly canAsk: boolean;
}

export function sessionCaller(): SessionAuthContext | null {
  return contextStorage.getStore()?.get(AuthKey) ?? null;
}

/**
 * Runs `fn` as a call `confirmed` approved, each of whom it may act as whoever spoke last.
 * `remembered` holds the callers' standing approvals, from `callerApprovals`, which release a
 * caller's identity unasked; unlike the caller's approval of this call, they don't make the call
 * read the caller as `auth.sender`. `canAsk` says eve can ask a person for this call.
 */
export function withCallIdentity<T>(
  identity: {
    readonly confirmed: readonly SessionPerson[];
    readonly remembered?: readonly string[];
    readonly canAsk?: boolean;
  },
  fn: () => T,
): T {
  const remembered = identity.remembered ?? [];
  if (identity.confirmed.length === 0 && remembered.length === 0 && identity.canAsk !== true)
    return fn();
  const value: CallIdentity = {
    canAsk: identity.canAsk === true,
    confirmed: new Set(identity.confirmed.map(principalOf)),
    remembered: new Set(remembered),
  };
  return withContextScopeValue(CALL_IDENTITY, value, fn);
}

/**
 * Runs `fn` with the caller's identity available whoever spoke last: for listing a connection's
 * tools, which runs nothing the model chose.
 */
export function withCallerIdentity<T>(fn: () => T): T {
  const caller = sessionCaller();
  return caller === null ? fn() : withCallIdentity({ confirmed: [caller] }, fn);
}

function callIdentity(): CallIdentity | undefined {
  return contextScopeValue<CallIdentity>(CALL_IDENTITY);
}

function approvedBy(person: SessionPerson | null): boolean {
  return person !== null && callIdentity()?.confirmed.has(principalOf(person)) === true;
}

/**
 * The one rule every guard of the caller's identity decides by, in the session step or outside
 * it: the caller spoke last, approved the call, or approved a call since someone else last spoke.
 */
export function callerIdentityReleased(input: {
  readonly current: SessionAuthContext | null;
  readonly sender: SessionAuthContext | null;
  readonly approved: boolean;
  readonly remembered: (key: string) => boolean;
}): boolean {
  if (callerSpokeLast(input) || input.approved) return true;
  const key = callerApprovalKey(input.current);
  return key !== undefined && input.remembered(key);
}

/**
 * Runs `fn` as a call the model made while `sender` had spoken last, whoever spoke since, as a
 * call that waited on a person runs. `undefined` leaves the turn's latest sender.
 */
export function withAskedSender<T>(sender: SessionAuthContext | null | undefined, fn: () => T): T {
  return sender === undefined ? fn() : withContextScopeValue(ASKED_SENDER, { sender }, fn);
}

/**
 * Who had spoken last as the model made the running call, whoever approved it: the sender a
 * waiting call was asked under, else `sender`, the turn's latest.
 */
function spokeLast(sender: SessionAuthContext | null): SessionAuthContext | null {
  const asked = contextScopeValue<{ readonly sender: SessionAuthContext | null }>(ASKED_SENDER);
  return asked === undefined ? sender : asked.sender;
}

/**
 * Who the running call reads as `auth.sender`: the caller for a call the caller approved, the
 * sender a waiting call was asked under, or else whoever spoke last in the turn.
 */
export function callSender(auth: {
  readonly current: SessionAuthContext | null;
  readonly sender: SessionAuthContext | null;
}): SessionAuthContext | null {
  return approvedBy(auth.current) ? auth.current : spokeLast(auth.sender);
}

const CALLER_APPROVAL_KEY = "eve.callerApproval";
/** How every `callerApprovalKey` starts. */
const CALLER_APPROVAL_KEY_PREFIX = `["${CALLER_APPROVAL_KEY}",`;

/**
 * The callers' standing approvals: those the session remembers, and in a local child session
 * those the delegating session remembered when it delegated.
 */
export function callerApprovals(
  remembered: ApprovalMemory["remembered"] | undefined,
  ctx: Pick<AlsContext, "get"> | undefined = contextStorage.getStore(),
): readonly string[] {
  const own = Object.entries(remembered ?? {}).flatMap(([key, approval]) =>
    approval.outcome === "accepted" && key.startsWith(CALLER_APPROVAL_KEY_PREFIX) ? [key] : [],
  );
  const inherited = ctx?.get(DelegatedIdentityKey)?.confirmed ?? [];
  return inherited.length === 0 ? own : [...new Set([...inherited, ...own])];
}

/**
 * Where eve remembers that `caller` approved a call that used their identity, until someone else
 * speaks. No one can approve for an anonymous caller, so there is nothing to remember for one.
 */
function callerApprovalKey(caller: SessionAuthContext | null): string | undefined {
  if (caller === null || caller.principalType === "anonymous") return undefined;
  return JSON.stringify([CALLER_APPROVAL_KEY, principalOf(caller)]);
}

/**
 * Whether a message from `sender` ends the caller approval remembered under `key`: a message from
 * anyone but that caller does.
 */
export function endsCallerApproval(key: string, sender: SessionAuthContext | null): boolean {
  return key.startsWith(CALLER_APPROVAL_KEY_PREFIX) && key !== callerApprovalKey(sender);
}

/** What eve asks for when a call stopped for a person's identity. */
export interface IdentityRequest {
  /** Whose identity the call needs. Only they can approve it. */
  readonly person: SessionPerson;
  /** Where the caller's approval is remembered, to cover their later calls until someone else speaks. */
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
  what = `${connectionName} access`,
): void {
  const refusal = callerRefusal(connectionName, ctx, what);
  if (refusal !== undefined) throw refusal;
}

/**
 * Guards work that acts as the caller outside a connection, such as `openCodeChannel()`: throws
 * the refusal eve turns into a request where it can ask the caller, and otherwise returns the
 * refusal's message. `undefined` when the caller's identity is released for the running call.
 */
export function callerIdentityRefusal(scope: string, what: string): string | undefined {
  const refusal = callerRefusal(scope, contextStorage.getStore(), what);
  if (callIdentity()?.canAsk === true && identityRequestOf(refusal) !== undefined) throw refusal;
  return refusal?.message;
}

function callerRefusal(
  connectionName: string,
  ctx: AlsContext | undefined,
  what: string,
): ConnectionAuthorizationFailedError | undefined {
  const needed = callerNeeded(ctx);
  return needed === undefined
    ? undefined
    : confirmationRequired(connectionName, callerConfirmationMessage(what), needed.request);
}

/**
 * What a call `steered()` marks needs before it runs: `undefined` while the caller's identity is
 * released for it, else what the model reads, and what eve asks the caller when it can name them.
 */
export function steeredConfirmation():
  | { readonly reason: string; readonly request?: IdentityRequest }
  | undefined {
  const needed = callerNeeded(contextStorage.getStore());
  return needed === undefined ? undefined : { ...needed, reason: STEERED_CONFIRMATION_MESSAGE };
}

/** `undefined` while the running call may act as the caller, else what eve can ask them. */
function callerNeeded(
  ctx: AlsContext | undefined,
): { readonly request?: IdentityRequest } | undefined {
  if (ctx === undefined) return undefined;
  const current = ctx.get(AuthKey) ?? null;
  const sender = spokeLast(readSender(ctx, current));
  const released = callerIdentityReleased({
    approved: approvedBy(current),
    current,
    remembered: (key) => callIdentity()?.remembered.has(key) === true,
    sender,
  });
  if (released) return undefined;
  const remember = callerApprovalKey(current);
  return remember === undefined
    ? {}
    : { request: { person: personOf(current!), remember: { key: remember } } };
}

/**
 * Throws unless the running call may use `person`'s identity for `connectionName`: they sent the
 * message the model read last as it made the call, or approved the call. A caller's standing
 * approval doesn't apply: the identity of someone who isn't the caller always needs them.
 */
export function requirePersonConfirmation(
  person: SessionPerson,
  connectionName: string,
  ctx: AlsContext | undefined,
): void {
  const sender = spokeLast(readSender(ctx, ctx?.get(AuthKey) ?? null));
  if (approvedBy(person) || principalOf(sender) === principalOf(person)) return;
  const name = JSON.stringify(person.principalId);
  throw confirmationRequired(
    connectionName,
    `${name} didn't send the latest message and hasn't approved this action, so it can't use ` +
      `their ${connectionName} access. Ask ${name} to clearly confirm this action. Retry only ` +
      `after a reply from them that plainly confirms it.`,
    { person },
  );
}

/**
 * What the model reads when the caller's `what` was refused: who to ask, and that only a reply
 * that plainly confirms the action counts.
 */
export function callerConfirmationMessage(what: string): string {
  return confirmFirst(`this action can't use their ${what} until they confirm it`);
}

/** What the model reads for a call `steered()` marks, where eve can't ask the caller. */
const STEERED_CONFIRMATION_MESSAGE = confirmFirst(
  "this action can't run until they confirm it, and it didn't run",
);

function confirmFirst(stopped: string): string {
  return (
    `Someone else has spoken since the person whose message started this turn, so ${stopped}. ` +
    `Ask the person whose message started this turn to clearly confirm this action. Retry only ` +
    `after a reply from them that plainly confirms it. If their reply is unclear or about ` +
    `something else, ask again instead of retrying.`
  );
}
