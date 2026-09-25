import type {
  AuthorizationRequiredStreamEvent,
  MessageCompletedStreamEvent,
  MessageStreamEvent,
  TurnFailureStreamEvent,
  UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import { isCurrentTurnBoundaryEvent, isTurnFailureEvent } from "#protocol/message.js";
import type { InputRequest } from "#shared/input.js";

/** A connection authorization challenge that remains unresolved at a turn boundary. */
export interface PendingAuthorization {
  readonly authorization?: AuthorizationRequiredStreamEvent["data"]["authorization"];
  readonly description: string;
  readonly name: string;
  readonly webhookUrl?: string;
}

/** Canonical projection of the lifecycle state represented by one turn's events. */
export interface TurnEventSummary {
  readonly boundary: UnstampedMessageStreamEvent | undefined;
  readonly failure: TurnFailureStreamEvent | undefined;
  readonly inputRequests: readonly InputRequest[];
  readonly message: string | undefined;
  readonly pendingAuthorizations: readonly PendingAuthorization[];
  readonly status: "completed" | "failed" | "waiting";
}

/** Reduces one turn's protocol events into their client-facing lifecycle state. */
export function summarizeTurnEvents(
  events: readonly UnstampedMessageStreamEvent[],
): TurnEventSummary {
  let boundary: UnstampedMessageStreamEvent | undefined;
  let failure: TurnFailureStreamEvent | undefined;
  let message: string | undefined;
  const inputRequests: InputRequest[] = [];
  const pendingAuthorizations = new Map<string, PendingAuthorization>();

  for (const event of events) {
    if (isCurrentTurnBoundaryEvent(event)) boundary = event;
    if (isTurnFailureEvent(event)) failure = event;
    if (isFinalMessageCompleted(event)) message = event.data.message ?? undefined;
    if (event.type === "input.requested") inputRequests.push(...event.data.requests);
    if (event.type === "authorization.required") {
      pendingAuthorizations.set(event.data.name, event.data);
    }
    if (event.type === "authorization.completed") {
      pendingAuthorizations.delete(event.data.name);
    }
  }

  return {
    boundary,
    failure,
    inputRequests,
    message,
    pendingAuthorizations: [...pendingAuthorizations.values()],
    status:
      boundary?.type === "session.waiting"
        ? "waiting"
        : boundary?.type === "session.failed"
          ? "failed"
          : "completed",
  };
}

/** Collects one segment of an event stream through its turn's end. */
export async function collectTurnEvents(
  stream: AsyncIterable<UnstampedMessageStreamEvent>,
): Promise<readonly UnstampedMessageStreamEvent[]> {
  const events: UnstampedMessageStreamEvent[] = [];
  const turnEnd = new TurnEndTracker();
  for await (const event of stream) {
    events.push(event);
    if (turnEnd.observe(event)) break;
  }
  return events;
}

/**
 * Follows one stream to the end of its turn. A held turn's waiting boundary
 * (`turn.completed` with `held: true`, then `session.waiting`) keeps the turn
 * open, so it is not the end, unless a request this stream saw is still
 * unanswered there: the stream stops so the caller can answer it.
 */
export class TurnEndTracker {
  #held = false;
  readonly #pendingRequests = new Set<string>();

  /** Whether the stream last reached a held turn's waiting boundary. */
  get held(): boolean {
    return this.#held;
  }

  /** Observes the next event and returns whether it ends the turn. */
  observe(event: UnstampedMessageStreamEvent): boolean {
    switch (event.type) {
      case "input.requested":
        for (const request of event.data.requests) this.#pendingRequests.add(request.requestId);
        break;
      case "input.resolved":
        for (const resolution of event.data.resolutions) {
          this.#pendingRequests.delete(resolution.requestId);
        }
        break;
      case "turn.completed":
        this.#held = event.data.held === true;
        return false;
      case "turn.started":
      case "turn.cancelled":
      case "turn.failed":
        this.#held = false;
        break;
      default:
        break;
    }
    if (!isCurrentTurnBoundaryEvent(event)) return false;
    return event.type !== "session.waiting" || !this.#held || this.#pendingRequests.size > 0;
  }
}

function isFinalMessageCompleted(
  event: UnstampedMessageStreamEvent,
): event is MessageCompletedStreamEvent {
  return (
    event.type === "message.completed" &&
    event.data.finishReason !== "tool-calls" &&
    event.data.interim !== true
  );
}

export function updatePendingAuthorizations(pending: Set<string>, event: MessageStreamEvent): void {
  if (event.type === "authorization.required" && event.data.webhookUrl !== undefined) {
    pending.add(event.data.name);
  } else if (event.type === "authorization.completed") {
    pending.delete(event.data.name);
  }
}
