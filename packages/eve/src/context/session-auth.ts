// The workflow driver reads principals, so this module stays free of the async context store.
import type { SessionAuthContext } from "#channel/types.js";
import type { ContextReader } from "#context/key.js";
import { AuthKey, InitiatorAuthKey, SenderAuthKey, type SessionAuth } from "#context/keys.js";

/** Every anonymous person shares this one principal. */
export const ANONYMOUS_PRINCIPAL = "anonymous";

/**
 * Stable key for the person a session identity or a recorded person names. Unauthenticated and
 * anonymous identities are one person.
 */
export function principalOf(person: SessionPerson | null | undefined): string {
  if (person === null || person === undefined || person.principalType === "anonymous") {
    return ANONYMOUS_PRINCIPAL;
  }
  return JSON.stringify([
    person.authenticator,
    person.issuer ?? null,
    person.principalType,
    person.principalId,
  ]);
}

/**
 * A person as eve records them beside the session: who they are, never their attributes, which
 * can carry a channel's short-lived tokens.
 */
export type SessionPerson = Pick<
  SessionAuthContext,
  "authenticator" | "issuer" | "principalId" | "principalType" | "subject"
>;

/** The person `auth` names, without its attributes. */
export function personOf(auth: SessionAuthContext): SessionPerson {
  return {
    authenticator: auth.authenticator,
    ...(auth.issuer !== undefined && { issuer: auth.issuer }),
    principalId: auth.principalId,
    principalType: auth.principalType,
    ...(auth.subject !== undefined && { subject: auth.subject }),
  };
}

/** `ctx.session.auth` as the session's context holds it; `current` defaults to its caller. */
export function readSessionAuth(
  ctx: Pick<ContextReader, "get">,
  current: SessionAuthContext | null = ctx.get(AuthKey) ?? null,
): SessionAuth {
  return {
    current,
    initiator: ctx.get(InitiatorAuthKey) ?? current,
    sender: readSender(ctx, current),
  };
}

/** Who spoke last in the turn: the person recorded while that isn't its caller, else `current`. */
export function readSender(
  ctx: Pick<ContextReader, "get"> | undefined,
  current: SessionAuthContext | null,
): SessionAuthContext | null {
  const sender = ctx?.get(SenderAuthKey);
  return sender === undefined ? current : sender;
}

/** Whether the caller is the last person to have spoken in the turn. */
export function callerSpokeLast(auth: {
  readonly current: SessionAuthContext | null | undefined;
  readonly sender: SessionAuthContext | null | undefined;
}): boolean {
  return principalOf(auth.current) === principalOf(auth.sender);
}
