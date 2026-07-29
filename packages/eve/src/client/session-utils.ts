import type {
  AuthorizationRequiredStreamEvent,
  MessageCompletedStreamEvent,
  TurnFailureStreamEvent,
  UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import { isCurrentTurnBoundaryEvent, isTurnFailureEvent } from "#protocol/message.js";
import type { SessionState } from "#client/types.js";
import type { InputRequest } from "#runtime/input/types.js";

/**
 * Returns a fresh session state with no active run.
 */
export function createInitialSessionState(): SessionState {
  return { streamIndex: 0 };
}

/**
 * Advances the session cursor after one streamed turn completes.
 *
 * When the boundary event is `session.waiting`, the session is preserved for
 * the next message. For `session.completed` and `session.failed`, the session
 * resets so the next call starts a new conversation. Without a boundary, the
 * session stays resumable from its advanced cursor.
 */
export function advanceSession(input: {
  readonly continuationToken?: string;
  readonly events: readonly UnstampedMessageStreamEvent[];
  readonly preserveCompletedSessions?: boolean;
  readonly sessionId: string;
  readonly session: SessionState;
}): SessionState {
  const boundaryEvent = findBoundaryEvent(input.events);
  const streamIndex = input.session.streamIndex + input.events.length;

  if (
    boundaryEvent?.type === "session.waiting" ||
    (input.preserveCompletedSessions === true && boundaryEvent?.type === "session.completed")
  ) {
    return {
      continuationToken:
        boundaryEvent?.type === "session.waiting"
          ? boundaryEvent.data.continuationToken
          : (input.continuationToken ?? input.session.continuationToken),
      sessionId: input.sessionId,
      streamIndex,
    };
  }

  if (boundaryEvent === undefined) {
    return {
      continuationToken: input.continuationToken ?? input.session.continuationToken,
      sessionId: input.sessionId,
      streamIndex,
    };
  }

  return createInitialSessionState();
}

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

function findBoundaryEvent(
  events: readonly UnstampedMessageStreamEvent[],
): UnstampedMessageStreamEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event !== undefined && isCurrentTurnBoundaryEvent(event)) return event;
  }
  return undefined;
}

function isFinalMessageCompleted(
  event: UnstampedMessageStreamEvent,
): event is MessageCompletedStreamEvent {
  return event.type === "message.completed" && event.data.finishReason !== "tool-calls";
}
