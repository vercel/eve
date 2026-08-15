import type {
  AuthorizationRequiredStreamEvent,
  MessageCompletedStreamEvent,
  TurnFailureStreamEvent,
  UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import { isCurrentTurnBoundaryEvent, isTurnFailureEvent } from "#protocol/message.js";
import type { InputRequest } from "#runtime/input/types.js";

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

/** Collects one segment of an event stream through its current-turn boundary. */
export async function collectTurnEvents(
  stream: AsyncIterable<UnstampedMessageStreamEvent>,
): Promise<readonly UnstampedMessageStreamEvent[]> {
  const events: UnstampedMessageStreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    if (isCurrentTurnBoundaryEvent(event)) break;
  }
  return events;
}

function isFinalMessageCompleted(
  event: UnstampedMessageStreamEvent,
): event is MessageCompletedStreamEvent {
  return event.type === "message.completed" && event.data.finishReason !== "tool-calls";
}
