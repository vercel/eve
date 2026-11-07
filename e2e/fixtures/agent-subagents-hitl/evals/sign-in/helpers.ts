import type { EveEvalContext } from "eve/evals";
import type { SessionStreamEvent } from "eve/client";

import { FAN_IN_DONE, FAN_IN_MARKER, type FanInPlan } from "../../agent/lib/weather-sign-in";

export {
  ACCEPT_CODE,
  CODE_TOKEN,
  EXCHANGE_FAILURE,
  FAILING_CODE,
  GRANT_TOKEN,
  HOLD_LIMIT_MS,
} from "../../agent/lib/weather-sign-in";

type Opened = Extract<SessionStreamEvent, { type: "interaction.opened" }>;
type Settled = Extract<SessionStreamEvent, { type: "interaction.settled" }>;

/** Each eval asks as its own person, so no two evals' sign-ins could ever meet. */
function asPerson(person: string) {
  return { headers: { "x-eve-fixture-user": person } };
}

/** The parent's stream as read so far, and a way to read on. */
export interface FanIn {
  /** Every event read so far, once each, in stream order. */
  readonly events: readonly SessionStreamEvent[];
  /** Reads on until `done` holds for every event read so far. */
  readUntil(done: (events: readonly SessionStreamEvent[]) => boolean): Promise<void>;
}

/** Starts the parent on `plan` as a fresh person, and reads its stream from the start. */
export async function startFanIn(t: EveEvalContext, plan: FanInPlan): Promise<FanIn> {
  const person = asPerson(`sign-in-${crypto.randomUUID()}`);
  const session = await t.session(person);
  await session.start(`${FAN_IN_MARKER} ${JSON.stringify(plan)}`, person);
  const reader = t.target.attach(session.id, { startIndex: 0 });
  const events: SessionStreamEvent[] = [];
  const seen = new Set<string>();
  const record = (event: SessionStreamEvent) => {
    const position = event.meta.position;
    const key = position === undefined ? undefined : `${position.line}:${position.index}`;
    if (key !== undefined && seen.has(key)) return;
    if (key !== undefined) seen.add(key);
    events.push(event);
  };
  return {
    events,
    async readUntil(done) {
      if (done(events)) return;
      await reader
        .watch({
          until: (event) => {
            record(event);
            return done(events);
          },
        })
        .result();
    },
  };
}

/** The sign-ins the parent recorded, in the order they opened. */
export function signIns(events: readonly SessionStreamEvent[]): Opened[] {
  return events.filter(
    (event): event is Opened =>
      event.type === "interaction.opened" && event.data.request.kind === "sign-in",
  );
}

/** The sign-ins a channel shows a card for: those that wait on no other card. */
export function shownCards(events: readonly SessionStreamEvent[]): Opened[] {
  return signIns(events).filter((card) => card.data.request.signIn?.waitsOn === undefined);
}

/** How each sign-in the parent recorded closed, in the order they closed. */
export function signInSettlements(events: readonly SessionStreamEvent[]): Settled[] {
  const ids = new Set(signIns(events).map((card) => card.data.interactionId));
  return events.filter(
    (event): event is Settled =>
      event.type === "interaction.settled" && ids.has(event.data.interactionId),
  );
}

/** Whether every sign-in the parent recorded has closed. */
export function allSettled(events: readonly SessionStreamEvent[]): boolean {
  return signInSettlements(events).length === signIns(events).length;
}

/** How each of the parent's turns settled. */
export function turnOutcomes(events: readonly SessionStreamEvent[]): string[] {
  return events.flatMap((event) => (event.type === "turn.settled" ? [event.data.outcome] : []));
}

/** Whether the parent's turn has settled. */
export function turnSettled(events: readonly SessionStreamEvent[]): boolean {
  return events.some((event) => event.type === "turn.settled");
}

/**
 * Answers a sign-in card the way the provider's redirect would: a GET on its callback URL with
 * `params`, such as a `code` or `error=access_denied`.
 */
export async function answer(
  t: EveEvalContext,
  card: Opened,
  params: Readonly<Record<string, string>>,
): Promise<void> {
  const signInUrl = card.data.request.signIn?.url;
  if (signInUrl === undefined) throw new Error("Expected the sign-in to carry its callback URL.");
  const url = new URL(signInUrl);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  const callback = await t.target.fetch(`${url.pathname}${url.search}`);
  if (!callback.ok) throw new Error(`The sign-in callback failed (${callback.status}).`);
}

/** One weather call a child reported. */
export interface Report {
  readonly city: string;
  readonly token: string;
  readonly at: number;
}

/** The parent's final reply: every weather call its children reported, and the errors. */
export function reportsIn(events: readonly SessionStreamEvent[]): {
  readonly calls: Report[];
  readonly errors: string[];
} {
  const reply = finalReply(events);
  const calls = [...reply.matchAll(/\[([^\]]+)\] token=(\S+) at=(\d+)/gu)].map((match) => ({
    at: Number(match[3]),
    city: match[1]!,
    token: match[2]!,
  }));
  const errors = [...reply.matchAll(/error=(.*)/gu)].map((match) => match[1]!);
  return { calls, errors };
}

/** The text of the parent's reply that reports its children, or `""` before it. */
function finalReply(events: readonly SessionStreamEvent[]): string {
  const texts = events.flatMap((event) => {
    if (event.type !== "content.completed" || event.data.kind !== "text") return [];
    const value = event.data.value;
    return typeof value === "string" && value.includes(FAN_IN_DONE) ? [value] : [];
  });
  return texts.at(-1) ?? "";
}

/** The ids of the sign-ins in `cards`. */
export function idsOf(cards: readonly Opened[]): string[] {
  return cards.map((card) => card.data.interactionId);
}
