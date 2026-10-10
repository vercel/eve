import { signInPromptOf, type SignInPrompt } from "#channel/interaction-prompts.js";
import type { SessionEvent } from "#protocol/session-event.js";
import type { ErrorInfo } from "#protocol/session-events/envelope.js";
import { emptySessionView, foldReceivedEvent } from "#protocol/session-projection/fold.js";
import { openRequests, openSignIns } from "#protocol/session-reader.js";
import type { InputRequest } from "#shared/input.js";

/** A connection authorization challenge that remains unresolved where a response ended. */
type PendingAuthorization = SignInPrompt;

/** What one response's events say, for a reader that wants the outcome. */
interface TurnEventSummary {
  readonly boundary: SessionEvent | undefined;
  readonly failure: ErrorInfo | undefined;
  readonly inputRequests: readonly InputRequest[];
  /** The reply's text, from the parts `turn.settled.reply` lists. */
  readonly message: string | undefined;
  readonly pendingAuthorizations: readonly PendingAuthorization[];
  readonly status: "completed" | "failed" | "waiting";
}

/** Reduces one response's events into their outcome. */
export function summarizeTurnEvents(events: readonly SessionEvent[]): TurnEventSummary {
  const segment = new ResponseSegment();
  const parts = new Map<string, { readonly kind: string; readonly value: unknown }>();
  let boundary: SessionEvent | undefined;
  let failure: ErrorInfo | undefined;
  let message: string | undefined;

  for (const event of events) {
    if (segment.observe(event)) boundary = segment.boundary;
    failure = failureOf(event) ?? failure;
    if (event.type === "content.completed") {
      parts.set(event.data.partId, { kind: event.data.kind, value: event.data.value });
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
    inputRequests: segment.inputRequests,
    message,
    pendingAuthorizations: segment.pendingAuthorizations,
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
  readonly #authorizations = new Map<string, PendingAuthorization>();
  readonly #deliveryId: string | undefined;
  #boundary: SessionEvent | undefined;

  constructor(options: { readonly deliveryId?: string } = {}) {
    this.#deliveryId = options.deliveryId;
  }

  get inputRequests(): readonly InputRequest[] {
    return openRequests(this.#view).map((input) => input.request);
  }

  get pendingAuthorizations(): readonly PendingAuthorization[] {
    return openSignIns(this.#view).flatMap(
      (attempt) => this.#authorizations.get(attempt.attemptId) ?? [],
    );
  }

  get boundary(): SessionEvent | undefined {
    return this.#boundary;
  }

  /** Records `event`; an ending fact ends the response after the rest of its commit. */
  observe(event: SessionEvent): boolean {
    foldReceivedEvent(this.#view, event);
    if (event.type === "interaction.opened") {
      const prompt = signInPromptOf(event.data, event.scope);
      if (prompt !== undefined) this.#authorizations.set(prompt.attemptId, prompt);
    }
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

export function authorizationKey(data: {
  readonly name: string;
  readonly attemptId?: string;
}): string {
  return data.attemptId === undefined ? `name:${data.name}` : `attempt:${data.attemptId}`;
}
