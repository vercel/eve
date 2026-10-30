import type { SessionEvent } from "#protocol/session-event.js";
import { deliveryStatus, type RequestStatus } from "#protocol/session-projection/request-status.js";
import type {
  DeliveryOutcome,
  DeliverySettledData,
} from "#protocol/session-events/families/delivery.js";
import type { TurnOutcome } from "#protocol/session-events/families/turn.js";
import type { ErrorInfo } from "#protocol/session-events/envelope.js";
import { emptySessionView, foldReceivedEvent } from "#protocol/session-projection/fold.js";
import { openInteractions } from "#protocol/session-projection/selectors.js";
import { interaction, type Interaction } from "#protocol/session-projection/reader.js";

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
  readonly status: RequestStatus | "working";
  readonly outcome: DeliveryOutcome | undefined;
  readonly sessionEnded: boolean;
}

/**
 * Reduces one response's events into their outcome. It reads the events themselves, not tables
 * folded from them: a response that joins a running turn starts after that turn's
 * `turn.started`, so a fold would never see the turn its `turn.settled` ends.
 */
export function summarizeTurnEvents(
  events: readonly SessionEvent[],
  deliveryId?: string,
): TurnEventSummary {
  const summary = turnSummary(deliveryId);
  for (const event of events) summary.observe(event);
  return summary.result();
}

/** Incremental response summary; progress events are folded, not retained. */
export function turnSummary(deliveryId?: string): {
  observe(event: SessionEvent): void;
  result(): TurnEventSummary;
} {
  const segment = new ResponseSegment({ deliveryId });
  let settlement: DeliverySettledData | undefined;
  let consumedBy: string | undefined;
  let sessionEnded = false;
  const outcomes = new Map<string, TurnOutcome>();
  const turnReplies = new Map<string, string | undefined>();
  const turnResults = new Map<string, unknown>();
  const turnFailures = new Map<string, ErrorInfo>();
  let sessionFailure: ErrorInfo | undefined;
  const parts = new Map<string, { readonly kind: string; readonly value: unknown }>();
  let boundary: SessionEvent | undefined;
  let failure: ErrorInfo | undefined;
  let message: string | undefined;
  let result: unknown;

  function observe(event: SessionEvent): void {
    if (event.type === "session.ended") sessionEnded = true;
    if (event.type === "delivery.consumed" && event.data.deliveryId === deliveryId)
      consumedBy = event.data.turnId;
    if (event.type === "delivery.settled" && event.data.deliveryId === deliveryId)
      settlement = event.data;
    if (event.type === "turn.settled") outcomes.set(event.data.turnId, event.data.outcome);
    if (segment.observe(event)) boundary = segment.boundary;
    const failed = failureOf(event);
    failure = failed ?? failure;
    if (failed !== undefined) {
      if (event.type === "turn.settled") turnFailures.set(event.data.turnId, failed);
      if (event.type === "session.ended") sessionFailure = failed;
    }
    if (event.type === "content.completed") {
      parts.set(event.data.partId, { kind: event.data.kind, value: event.data.value });
      if (event.data.kind === "result") {
        result = event.data.value;
        if (event.scope?.turnId !== undefined) turnResults.set(event.scope.turnId, result);
      }
    }
    if (event.type === "turn.settled") {
      const text = (event.data.reply ?? []).flatMap((partId) => {
        const part = parts.get(partId);
        return part?.kind === "text" && typeof part.value === "string" ? [part.value] : [];
      });
      message = text.length === 0 ? undefined : text.join("\n");
      turnReplies.set(event.data.turnId, message);
      for (const partId of event.data.reply ?? []) {
        const part = parts.get(partId);
        if (part?.kind === "result") turnResults.set(event.data.turnId, part.value);
      }
    }
  }

  function summarize(): TurnEventSummary {
    const turnId = settlement?.turnId ?? consumedBy;
    const status =
      deliveryId === undefined
        ? summarizeBoundaryStatus(boundary, failure)
        : deliveryStatus(
            settlement?.outcome,
            outcomes.get(turnId ?? ""),
            sessionFailure === undefined ? undefined : "failed",
          );
    if (deliveryId !== undefined) {
      const conversational =
        settlement?.outcome === "handled" || settlement?.outcome === "awaiting-input";
      message = conversational && turnId !== undefined ? turnReplies.get(turnId) : undefined;
      result = conversational && turnId !== undefined ? turnResults.get(turnId) : undefined;
      failure =
        status === "failed" ? (turnFailures.get(turnId ?? "") ?? sessionFailure) : undefined;
      if (status === "failed" && failure === undefined) {
        failure = {
          code: settlement?.outcome === "refused" ? "DELIVERY_REFUSED" : "DELIVERY_FAILED",
          message:
            settlement?.reason ??
            (settlement?.outcome === "refused"
              ? "The delivery was refused."
              : "The delivery failed."),
        };
      }
    }
    return {
      boundary,
      failure,
      interactions: segment.interactions,
      message,
      result,
      sessionEnded,
      status,
      outcome: settlement?.outcome,
    };
  }
  return { observe, result: summarize };
}

function summarizeBoundaryStatus(
  boundary: SessionEvent | undefined,
  failure: ErrorInfo | undefined,
): TurnEventSummary["status"] {
  if (failure !== undefined) return "failed";
  if (boundary?.type === "turn.settled") return boundary.data.outcome;
  if (boundary?.type === "session.ended") return boundary.data.outcome;
  return boundary?.type === "turn.paused" ? "awaiting-input" : "working";
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
  deliveryId?: string,
): Promise<readonly SessionEvent[]> {
  const events: SessionEvent[] = [];
  const segment = new ResponseSegment({ deliveryId });
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
