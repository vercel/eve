import type { SessionEvent } from "#protocol/session-event.js";
import type { ErrorInfo } from "#protocol/session-events/envelope.js";
import { emptySessionView, foldReceivedEvent } from "#protocol/session-projection/fold.js";
import { openInteractions } from "#protocol/session-projection/selectors.js";
import { interaction } from "#protocol/session-reader.js";
import type { Interaction } from "#protocol/session-reader.js";

/** What one response's events say, for a reader that wants the outcome. */
interface TurnEventSummary {
  readonly boundary: SessionEvent | undefined;
  readonly failure: ErrorInfo | undefined;
  /** What the response leaves open for people: answers it asks for, and sign-ins. */
  readonly interactions: readonly Interaction[];
  /** The reply's text, from the parts `turn.settled.reply` lists. */
  readonly message: string | undefined;
  /** The value of the latest `result` part, whatever its phase. */
  readonly result: unknown;
  readonly status: "completed" | "failed" | "waiting";
}

/**
 * Reduces one response's events into their outcome. It reads the events themselves, not tables
 * folded from them: a response that joins a running turn starts after that turn's
 * `turn.started`, so a fold would never see the turn its `turn.settled` ends.
 */
export function summarizeTurnEvents(events: readonly SessionEvent[]): TurnEventSummary {
  const segment = new ResponseSegment();
  const parts = new Map<string, { readonly kind: string; readonly value: unknown }>();
  let boundary: SessionEvent | undefined;
  let failure: ErrorInfo | undefined;
  let message: string | undefined;
  let result: unknown;

  for (const event of events) {
    if (segment.observe(event)) boundary = segment.boundary;
    failure = failureOf(event) ?? failure;
    if (event.type === "content.completed") {
      parts.set(event.data.partId, { kind: event.data.kind, value: event.data.value });
      if (event.data.kind === "result") result = event.data.value;
    }
    if (event.type === "turn.settled") {
      const text = (event.data.reply ?? []).flatMap((partId) => {
        const part = parts.get(partId);
        return part?.kind === "text" && typeof part.value === "string" ? [part.value] : [];
      });
      message = text.length === 0 ? undefined : text.join("\n");
    }
  }

  return {
    boundary,
    failure,
    interactions: segment.interactions,
    message,
    result,
    status: summarizeBoundaryStatus(boundary, failure),
  };
}

function summarizeBoundaryStatus(
  boundary: SessionEvent | undefined,
  failure: ErrorInfo | undefined,
): TurnEventSummary["status"] {
  if (failure !== undefined) return "failed";
  // A response ends "waiting" while its session stays open for the next message or answer;
  // only a session that ended has completed.
  return boundary?.type === "session.ended" ? "completed" : "waiting";
}

/** The failure an event reports: a turn's, a run's, or the session's. */
export function failureOf(event: SessionEvent): ErrorInfo | undefined {
  if (event.type === "turn.settled" && event.data.outcome === "failed") {
    return event.data.error ?? { code: "TURN_FAILED", message: "The turn failed." };
  }
  if (event.type === "session.ended" && event.data.outcome === "failed") {
    return event.data.error ?? { code: "SESSION_FAILED", message: "The session failed." };
  }
  return undefined;
}

/** Collects one response's events, through its end. */
export async function collectTurnEvents(
  stream: AsyncIterable<SessionEvent>,
): Promise<readonly SessionEvent[]> {
  const events: SessionEvent[] = [];
  const segment = new ResponseSegment();
  for await (const event of stream) {
    events.push(event);
    if (segment.observe(event)) break;
  }
  return events;
}

/**
 * True when a read that follows no delivery ends at `event`: the turn settled, the session
 * ended, or the turn paused on a person, who must act before it goes on.
 */
export function endsTurn(event: SessionEvent): boolean {
  if (event.type === "turn.settled" || event.type === "session.ended") return true;
  return (
    event.type === "turn.paused" && event.data.awaiting.some((entry) => "interactionId" in entry)
  );
}

/**
 * One response's events, from where a reader started, and the requests and sign-ins they leave
 * open. A response to a delivery ends when that delivery settles, however it settles, or when
 * the session ends first; a read that follows no delivery ends with the turn ({@link endsTurn}).
 */
export class ResponseSegment {
  readonly #view = emptySessionView();
  readonly #deliveryId: string | undefined;
  #boundary: SessionEvent | undefined;

  constructor(options: { readonly deliveryId?: string } = {}) {
    this.#deliveryId = options.deliveryId;
  }

  get interactions(): readonly Interaction[] {
    return openInteractions(this.#view).flatMap(
      (row) => interaction(this.#view, row.interactionId) ?? [],
    );
  }

  get boundary(): SessionEvent | undefined {
    return this.#boundary;
  }

  /** Records `event`; an ending fact ends the response after the rest of its commit. */
  observe(event: SessionEvent): boolean {
    foldReceivedEvent(this.#view, event);
    const ends =
      this.#deliveryId === undefined
        ? endsTurn(event)
        : event.type === "session.ended" ||
          (event.type === "delivery.settled" && event.data.deliveryId === this.#deliveryId);
    if (ends) this.#boundary = event;
    // Raw producer facts have no metadata. Materialized reader events mark the last known
    // record so a turn terminal never hides its deliveries or a session terminal in that line.
    const meta = "meta" in event ? event.meta : undefined;
    const endOfLine =
      meta !== null && typeof meta === "object" && "endOfLine" in meta ? meta.endOfLine : undefined;
    return this.#boundary !== undefined && endOfLine !== false;
  }
}
