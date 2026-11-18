import type { SessionStreamEvent } from "#protocol/session-event.js";

import { countCurrentTurnBoundaryEvents, extractCurrentTurnBoundaryEvent } from "./stream.js";

export interface DevelopmentSessionState {
  readonly boundaryCount: number;
  readonly streamIndex: number;
  readonly sessionId?: string;
}

export function createDevelopmentSessionState(
  input: {
    readonly boundaryCount?: number;
    readonly sessionId?: string;
    readonly streamIndex?: number;
  } = {},
): DevelopmentSessionState {
  return {
    boundaryCount: input.boundaryCount ?? 0,
    sessionId: input.sessionId,
    streamIndex: input.streamIndex ?? 0,
  };
}

export function createDevelopmentMessageRequest(input: {
  readonly message: string;
  readonly session: DevelopmentSessionState;
}) {
  return {
    message: input.message,
  };
}

export function updateDevelopmentSessionState(input: {
  readonly events: readonly SessionStreamEvent[];
  readonly sessionId: string;
  readonly session: DevelopmentSessionState;
}): DevelopmentSessionState {
  const boundaryEvent = extractCurrentTurnBoundaryEvent(input.events);
  const boundaryCount = input.session.boundaryCount + countCurrentTurnBoundaryEvents(input.events);
  const streamIndex = input.events.reduce(
    (next, event) => Math.max(next, event.meta.position.line + 1),
    input.session.streamIndex,
  );

  if (boundaryEvent !== undefined && boundaryEvent.type !== "session.ended") {
    return createDevelopmentSessionState({
      boundaryCount,
      sessionId: input.sessionId,
      streamIndex,
    });
  }

  return createDevelopmentSessionState();
}
