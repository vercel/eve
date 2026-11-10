import type { SessionAuthContext } from "#channel/types.js";
import { contextStorage } from "#context/container.js";
import type { ContextReader } from "#context/key.js";
import { personAuth, personOf, principalOf, type SessionPerson } from "#context/session-auth.js";
import type { SessionStateMap } from "#harness/types.js";

// The model is told who is speaking when the speaker changes. A session with one person never
// reads a sender line. eve also records who has spoken, so a tool can name one of them with
// `ctx.getToken(provider, { as })`.

const LAST_SENDER_KEY = "eve.harness.lastSender";
const PARTICIPANTS_KEY = "eve.harness.participants";
/** How many people the session remembers, the most recent to speak first to go last. */
const MAX_PARTICIPANTS = 50;

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

/**
 * Remembers who sent the message the model reads now, for the next sender line, and records them
 * among the session's participants.
 */
export function rememberSender<T extends { readonly state?: SessionStateMap }>(
  session: T,
  auth: SessionAuthContext | null,
): T {
  const next = senderOf(auth);
  const last = session.state?.[LAST_SENDER_KEY] as Sender | undefined;
  const recorded = readParticipants(session.state);
  const known =
    recorded.at(-1) !== undefined && principalOf(personAuth(recorded.at(-1)!)) === next.principal;
  const participants =
    next.id === undefined || auth === null || known
      ? undefined
      : [
          ...recorded.filter((person) => principalOf(personAuth(person)) !== next.principal),
          personOf(auth),
        ].slice(-MAX_PARTICIPANTS);
  if (last?.principal === next.principal && participants === undefined) return session;
  return {
    ...session,
    state: {
      ...session.state,
      [LAST_SENDER_KEY]: next,
      ...(participants !== undefined && { [PARTICIPANTS_KEY]: participants }),
    },
  };
}

/**
 * Forgets the last sender and the participants with the conversation they spoke in, when the
 * context is cleared.
 */
export function forgetSender<T extends { readonly state?: SessionStateMap }>(session: T): T {
  if (
    session.state?.[LAST_SENDER_KEY] === undefined &&
    session.state?.[PARTICIPANTS_KEY] === undefined
  )
    return session;
  const { [LAST_SENDER_KEY]: _last, [PARTICIPANTS_KEY]: _participants, ...state } = session.state;
  return { ...session, state };
}

/** The signed-in people who have spoken in the session, the most recent last. */
export function readParticipants(state: SessionStateMap | undefined): readonly SessionPerson[] {
  return (state?.[PARTICIPANTS_KEY] as readonly SessionPerson[] | undefined) ?? [];
}

// The participants of the session a step runs, for a tool the step runs. Never serialized: the
// step's session state holds the record. Rooted on `globalThis`, like the step's live projection,
// so every bundled copy of eve in a step reads the same one.
const LIVE_PARTICIPANTS_KEY = Symbol.for("eve.live-session-participants");
type LiveParticipantsGlobal = typeof globalThis & {
  [LIVE_PARTICIPANTS_KEY]?: WeakMap<ContextReader, () => SessionStateMap | undefined>;
};
const liveParticipants = ((globalThis as LiveParticipantsGlobal)[LIVE_PARTICIPANTS_KEY] ??=
  new WeakMap());

/** Lets the tools a step runs read its session's participants, as the step's state holds them. */
export function enterParticipants(
  ctx: ContextReader,
  state: () => SessionStateMap | undefined,
): void {
  liveParticipants.set(ctx, state);
}

/**
 * The participants of the session the running step belongs to, or `undefined` outside a session
 * step, such as in a workflow-step tool.
 */
export function sessionParticipants(
  ctx: ContextReader | undefined = contextStorage.getStore(),
): readonly SessionPerson[] | undefined {
  const state = ctx === undefined ? undefined : liveParticipants.get(ctx);
  return state === undefined ? undefined : readParticipants(state());
}
