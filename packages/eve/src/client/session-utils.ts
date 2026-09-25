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
 * Follows one response to the end of its turn. `session.waiting` opens the
 * session to input, but a turn held on its tasks is still open there (the
 * response saw it start or receive its message, and not complete, fail, or
 * get cancelled), so the response goes on to the turn's end, unless a request
 * it streamed awaits an answer.
 */
export class TurnEndTracker {
  #openTurn = false;
  readonly #pendingRequests = new Set<string>();

  /** Observes the next event and returns whether it ends the response. */
  observe(event: UnstampedMessageStreamEvent): boolean {
    switch (event.type) {
      // A message sent while a turn holds joins it: its response starts there.
      case "turn.started":
      case "message.received":
        this.#openTurn = true;
        break;
      case "turn.completed":
      case "turn.cancelled":
      case "turn.failed":
        this.#openTurn = false;
        break;
      case "input.requested":
        for (const request of event.data.requests) this.#pendingRequests.add(request.requestId);
        break;
      case "input.resolved":
        for (const resolution of event.data.resolutions) {
          this.#pendingRequests.delete(resolution.requestId);
        }
        break;
      default:
        break;
    }
    if (!isCurrentTurnBoundaryEvent(event)) return false;
    return event.type !== "session.waiting" || !this.#openTurn || this.#pendingRequests.size > 0;
  }
}

function isFinalMessageCompleted(
  event: UnstampedMessageStreamEvent,
): event is MessageCompletedStreamEvent {
  return event.type === "message.completed" && event.data.finishReason !== "tool-calls";
}

export function updatePendingAuthorizations(pending: Set<string>, event: MessageStreamEvent): void {
  if (event.type === "authorization.required" && event.data.webhookUrl !== undefined) {
    pending.add(event.data.name);
  } else if (event.type === "authorization.completed") {
    pending.delete(event.data.name);
  }
}
