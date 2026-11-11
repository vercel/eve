import type { SessionAuthContext } from "#channel/types.js";
import { contextStorage } from "#context/container.js";
import type { ContextReader } from "#context/key.js";
import { DelegatedIdentityKey } from "#context/keys.js";
import { personOf, principalOf, type SessionPerson } from "#context/session-auth.js";
import type { SessionStateMap } from "#harness/types.js";
import { turnPosition } from "#harness/session-machine/view.js";
import type { SessionProjection } from "#protocol/session-projection.js";
import type { Principal } from "#protocol/session-events/envelope.js";

// The model is told who is speaking when the speaker changes. A session with one person never
// reads a sender line. eve also records who has spoken, so a tool can name one of them with
// `ctx.getToken(provider, { as })`.

const LAST_SENDER_KEY = "eve.harness.lastSender";
const PARTICIPANTS_KEY = "eve.harness.participants";
/** How many people the session remembers, the most recent to speak first to go last. */
const MAX_PARTICIPANTS = 50;
/** How many senders' latest messages a local child inherits, and how much of each. */
const MAX_DELEGATED_MESSAGES = 10;
const DELEGATED_MESSAGE_LIMIT = 1_000;

export interface TurnMessage {
  readonly from: Principal;
  readonly text: string;
}

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

// A channel can carry any id, so it is JSON-quoted to keep it from passing for eve's words.
function nameOf(sender: Sender): string {
  return sender.id === undefined ? "someone who isn't signed in" : JSON.stringify(sender.id);
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
  const known = recorded.at(-1) !== undefined && principalOf(recorded.at(-1)!) === next.principal;
  const participants =
    next.id === undefined || auth === null || known
      ? undefined
      : [
          ...recorded.filter((person) => principalOf(person) !== next.principal),
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
 * step, such as in a workflow-step tool. A local child session also counts the people who had
 * spoken in the session that delegated to it.
 */
export function sessionParticipants(
  ctx: ContextReader | undefined = contextStorage.getStore(),
): readonly SessionPerson[] | undefined {
  const state = ctx === undefined ? undefined : liveParticipants.get(ctx);
  return state === undefined ? undefined : participantsOf(state(), ctx);
}

export function turnMessages(
  projection: SessionProjection,
  turnId = turnPosition(projection).turnId,
): readonly TurnMessage[] {
  return Object.values(projection.view.deliveries)
    .flatMap((delivery) => {
      if (delivery.turnId !== turnId || delivery.consumedAt === undefined) return [];
      if (delivery.principal === undefined) return [];
      const text = (delivery.parts ?? [])
        .flatMap((part) => (part.kind === "text" ? [part.text] : []))
        .join(" ")
        .trim();
      return text.length === 0 ? [] : [{ at: delivery.consumedAt, from: delivery.principal, text }];
    })
    .sort((a, b) => a.at - b.at)
    .map(({ from, text }) => ({ from, text }));
}

/**
 * Whether `person` sent a message the turn read. A delivery names its sender without how they
 * signed in, so it is the person's only when no one else who has spoken could have sent it.
 */
export function sentBy(message: TurnMessage, person: SessionPerson): boolean {
  const key = principalOf(person);
  const others = (sessionParticipants() ?? []).filter((other) => principalOf(other) !== key);
  return names(message.from, person) && !others.some((other) => names(message.from, other));
}

/** Whether a delivery's principal names `person`, as far as the wire tells. */
function names(principal: Principal, person: SessionPerson): boolean {
  return (
    principal.id === person.principalId &&
    principal.type === person.principalType &&
    (principal.issuer ?? null) === (person.issuer ?? null)
  );
}

/** The messages a local child session inherited from the turn that delegated to it. */
export function delegatedMessages(
  ctx: Pick<ContextReader, "get"> | undefined = contextStorage.getStore(),
): readonly TurnMessage[] | undefined {
  return ctx?.get(DelegatedIdentityKey)?.messages;
}

/**
 * What a local child inherits of the messages its parent's turn read: the latest from each
 * sender, oldest first, including those the parent itself inherited.
 */
export function messagesToDelegate(
  projection: SessionProjection,
  ctx: Pick<ContextReader, "get"> | undefined,
): readonly TurnMessage[] {
  const latest = new Map<string, TurnMessage>();
  for (const message of [...(delegatedMessages(ctx) ?? []), ...turnMessages(projection)]) {
    const key = JSON.stringify([message.from.id, message.from.type, message.from.issuer ?? null]);
    latest.delete(key);
    latest.set(key, { from: message.from, text: message.text.slice(0, DELEGATED_MESSAGE_LIMIT) });
  }
  return [...latest.values()].slice(-MAX_DELEGATED_MESSAGES);
}

/**
 * The people who have spoken in a session, the most recent last: those its state records, after
 * those who had spoken in the session that delegated to it.
 */
export function participantsOf(
  state: SessionStateMap | undefined,
  ctx: Pick<ContextReader, "get"> | undefined,
): readonly SessionPerson[] {
  const own = readParticipants(state);
  const inherited = ctx?.get(DelegatedIdentityKey)?.participants ?? [];
  if (inherited.length === 0) return own;
  const spoke = new Set(own.map(principalOf));
  return [...inherited.filter((person) => !spoke.has(principalOf(person))), ...own].slice(
    -MAX_PARTICIPANTS,
  );
}
