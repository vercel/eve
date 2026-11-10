import type { SessionAuthContext } from "#channel/types.js";
import { principalOf } from "#context/session-auth.js";
import type { SessionStateMap } from "#harness/types.js";

// The model is told who is speaking when the speaker changes. A session with one person never
// reads a sender line.

const LAST_SENDER_KEY = "eve.harness.lastSender";

/** The person whose message the model read last, as a sender line names them. */
interface Sender {
  /** Their `principalId`; absent for someone who isn't signed in. */
  readonly id?: string;
  readonly principal: string;
}

function senderOf(auth: SessionAuthContext | null): Sender {
  const principal = principalOf(auth);
  return auth === null || auth.principalType === "anonymous"
    ? { principal }
    : { id: auth.principalId, principal };
}

function nameOf(sender: Sender): string {
  return sender.id ?? "someone who isn't signed in";
}

/**
 * The line eve adds before a message whose sender differs from the sender of the message the
 * model read before it, or `undefined` when the same person is still speaking.
 */
export function senderLine(
  state: SessionStateMap | undefined,
  auth: SessionAuthContext | null,
): string | undefined {
  const last = state?.[LAST_SENDER_KEY] as Sender | undefined;
  const next = senderOf(auth);
  if (last === undefined || last.principal === next.principal) return undefined;
  return (
    `The next message is from a different person than the message before it. ` +
    `It is from ${nameOf(next)}. The message before it was from ${nameOf(last)}.`
  );
}

/** Remembers who sent the message the model reads now, for the next sender line. */
export function rememberSender<T extends { readonly state?: SessionStateMap }>(
  session: T,
  auth: SessionAuthContext | null,
): T {
  const next = senderOf(auth);
  const last = session.state?.[LAST_SENDER_KEY] as Sender | undefined;
  if (last?.principal === next.principal) return session;
  return { ...session, state: { ...session.state, [LAST_SENDER_KEY]: next } };
}

/** Forgets the last sender with the conversation it spoke in, when the context is cleared. */
export function forgetSender<T extends { readonly state?: SessionStateMap }>(session: T): T {
  if (session.state?.[LAST_SENDER_KEY] === undefined) return session;
  const { [LAST_SENDER_KEY]: _last, ...state } = session.state;
  return { ...session, state };
}
