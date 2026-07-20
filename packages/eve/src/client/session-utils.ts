import type { HandleMessageStreamEvent, MessageCompletedStreamEvent } from "#protocol/message.js";
import { isCurrentTurnBoundaryEvent } from "#protocol/message.js";
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
 * resets so the next call starts a new conversation.
 */
export function advanceSession(input: {
  readonly continuationToken?: string;
  readonly events: readonly HandleMessageStreamEvent[];
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

  return createInitialSessionState();
}

/**
 * Extracts the final completed assistant message text from a turn's events.
 *
 * Only considers terminal messages (finish reason is not `"tool-calls"`).
 */
export function extractCompletedMessage(
  events: readonly HandleMessageStreamEvent[],
): string | undefined {
  let lastMessage: string | undefined;

  for (const event of events) {
    if (isFinalMessageCompleted(event)) {
      lastMessage = event.data.message ?? undefined;
    }
  }

  return lastMessage;
}

/**
 * Derives the result status from a turn's boundary event.
 */
export function deriveResultStatus(
  events: readonly HandleMessageStreamEvent[],
): "completed" | "failed" | "waiting" {
  const boundary = findBoundaryEvent(events);

  if (boundary?.type === "session.waiting") return "waiting";
  if (boundary?.type === "session.failed") return "failed";
  return "completed";
}

/**
 * Collects HITL input requests emitted during one consumed turn.
 */
export function extractInputRequests(
  events: readonly HandleMessageStreamEvent[],
): readonly InputRequest[] {
  const requests: InputRequest[] = [];

  for (const event of events) {
    if (event.type === "input.requested") {
      requests.push(...event.data.requests);
    }
  }

  return requests;
}

function findBoundaryEvent(
  events: readonly HandleMessageStreamEvent[],
): HandleMessageStreamEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event !== undefined && isCurrentTurnBoundaryEvent(event)) return event;
  }
  return undefined;
}

function isFinalMessageCompleted(
  event: HandleMessageStreamEvent,
): event is MessageCompletedStreamEvent {
  return event.type === "message.completed" && event.data.finishReason !== "tool-calls";
}
