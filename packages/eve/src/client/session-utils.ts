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
interface PendingAuthorization {
  readonly authorization?: AuthorizationRequiredStreamEvent["data"]["authorization"];
  readonly description: string;
  readonly name: string;
  readonly attemptId?: string;
  readonly webhookUrl?: string;
}

/** Canonical projection of the lifecycle state represented by one turn's events. */
interface TurnEventSummary {
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
  const inputRequests = new Map<string, InputRequest>();
  const pendingInputRequests = new Set<string>();
  const pendingAuthorizations = new Map<string, PendingAuthorization>();

  for (const event of events) {
    updatePendingInputRequests(pendingInputRequests, event);
    if (isTurnSegmentBoundary(event, pendingInputRequests)) boundary = event;
    if (isTurnFailureEvent(event)) failure = event;
    if (isFinalMessageCompleted(event)) message = event.data.message ?? undefined;
    // Text completed before the turn parked was interim; the reply comes after it resumes.
    if (event.type === "turn.waiting") message = undefined;
    if (event.type === "input.requested") {
      for (const request of event.data.requests) inputRequests.set(request.requestId, request);
    }
    if (event.type === "approval.settled") inputRequests.delete(event.data.requestId);
    if (event.type === "input.resolved") {
      for (const resolution of event.data.resolutions) inputRequests.delete(resolution.requestId);
    }
    if (event.type === "authorization.required") {
      pendingAuthorizations.set(authorizationKey(event.data), event.data);
    }
    if (event.type === "authorization.completed") {
      pendingAuthorizations.delete(authorizationKey(event.data));
    }
  }

  return {
    boundary,
    failure,
    inputRequests: [...inputRequests.values()],
    message,
    pendingAuthorizations: [...pendingAuthorizations.values()],
    status: summarizeBoundaryStatus(boundary),
  };
}

function summarizeBoundaryStatus(
  boundary: UnstampedMessageStreamEvent | undefined,
): TurnEventSummary["status"] {
  if (boundary?.type === "session.waiting" || boundary?.type === "turn.waiting") return "waiting";
  if (boundary?.type === "session.failed") return "failed";
  return "completed";
}

/** Collects one segment of an event stream through its current-turn boundary. */
export async function collectTurnEvents(
  stream: AsyncIterable<UnstampedMessageStreamEvent>,
): Promise<readonly UnstampedMessageStreamEvent[]> {
  const events: UnstampedMessageStreamEvent[] = [];
  const pendingInputRequests = new Set<string>();
  for await (const event of stream) {
    events.push(event);
    updatePendingInputRequests(pendingInputRequests, event);
    if (isTurnSegmentBoundary(event, pendingInputRequests)) break;
  }
  return events;
}

/**
 * Returns true when one segment of a turn's events ends at `event`: at a
 * current-turn boundary, or at `turn.waiting` while an input request read in
 * the segment is unanswered. The turn stays open there until a person answers;
 * without a pending request, `turn.waiting` is informational and reading goes
 * on to the turn's real end.
 */
export function isTurnSegmentBoundary(
  event: UnstampedMessageStreamEvent,
  pendingInputRequests: ReadonlySet<string>,
): boolean {
  if (event.type === "turn.waiting") return pendingInputRequests.size > 0;
  return isCurrentTurnBoundaryEvent(event);
}

/** Tracks the input requests read in a segment that no `input.resolved` has answered yet. */
export function updatePendingInputRequests(
  pending: Set<string>,
  event: UnstampedMessageStreamEvent,
): void {
  if (event.type === "input.requested") {
    for (const request of event.data.requests) pending.add(request.requestId);
  } else if (event.type === "input.resolved") {
    for (const resolution of event.data.resolutions) pending.delete(resolution.requestId);
  }
}

function isFinalMessageCompleted(
  event: UnstampedMessageStreamEvent,
): event is MessageCompletedStreamEvent {
  return event.type === "message.completed" && event.data.finishReason !== "tool-calls";
}

export function authorizationKey(data: {
  readonly name: string;
  readonly attemptId?: string;
}): string {
  return data.attemptId === undefined ? `name:${data.name}` : `attempt:${data.attemptId}`;
}

export function updatePendingAuthorizations(pending: Set<string>, event: MessageStreamEvent): void {
  if (event.type === "authorization.required" && event.data.webhookUrl !== undefined) {
    pending.add(authorizationKey(event.data));
  } else if (event.type === "authorization.completed") {
    pending.delete(authorizationKey(event.data));
  }
}
