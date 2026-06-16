import type { HandleMessageRequestBody, HandleMessageStreamEvent } from "#protocol/message.js";
import { countCurrentTurnBoundaryEvents, extractCurrentTurnBoundaryEvent } from "./stream.js";

/**
 * Durable-session cursor owned by the development client.
 */
export interface DevelopmentSessionState {
  /**
   * Number of turn-boundary events already consumed from the run stream.
   */
  readonly boundaryCount: number;
  /**
   * V2 continuation token for resuming a parked session across turns.
   */
  readonly continuationToken?: string;
  /**
   * Number of streamed workflow chunks already consumed from the session stream.
   */
  readonly streamIndex: number;
  /**
   * Active session id when the workflow is parked for the next user message.
   */
  readonly sessionId?: string;
}

/**
 * Returns the session state used before any message is sent or when the
 * client resumes a known waiting run.
 */
export function createDevelopmentSessionState(
  input: {
    readonly boundaryCount?: number;
    readonly continuationToken?: string;
    readonly sessionId?: string;
    readonly streamIndex?: number;
  } = {},
): DevelopmentSessionState {
  return {
    boundaryCount: input.boundaryCount ?? 0,
    continuationToken: input.continuationToken,
    sessionId: input.sessionId,
    streamIndex: input.streamIndex ?? 0,
  };
}

/**
 * Creates the next canonical message-route request for the current session
 * state.
 */
export function createDevelopmentMessageRequest(input: {
  readonly message: string;
  readonly session: DevelopmentSessionState;
}): HandleMessageRequestBody {
  if (input.session.continuationToken) {
    return {
      continuationToken: input.session.continuationToken,
      message: input.message,
    };
  }

  return {
    message: input.message,
  };
}

/**
 * Advances the durable session cursor after one streamed turn boundary is
 * observed.
 */
export function updateDevelopmentSessionState(input: {
  readonly continuationToken?: string;
  readonly events: readonly HandleMessageStreamEvent[];
  readonly sessionId: string;
  readonly session: DevelopmentSessionState;
}): DevelopmentSessionState {
  const boundaryEvent = extractCurrentTurnBoundaryEvent(input.events);
  const boundaryCount = input.session.boundaryCount + countCurrentTurnBoundaryEvents(input.events);
  const streamIndex = input.session.streamIndex + input.events.length;

  if (boundaryEvent?.type === "session.waiting") {
    return createDevelopmentSessionState({
      boundaryCount,
      continuationToken: input.continuationToken ?? input.session.continuationToken,
      sessionId: input.sessionId,
      streamIndex,
    });
  }

  return createDevelopmentSessionState();
}
