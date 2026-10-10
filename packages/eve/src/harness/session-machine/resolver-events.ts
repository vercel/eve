import {
  createSessionStartedEvent,
  createStepStartedEvent,
  createTurnStartedEvent,
  type RuntimeIdentity,
} from "#protocol/message.js";

// The events resolvers (dynamic tools, connections, models) receive to describe where the
// session is when they run. They are never published: the transitions publish the real ones.

export function sessionStartedForResolvers(runtime?: RuntimeIdentity) {
  return createSessionStartedEvent({ runtime });
}

export function turnStartedForResolvers(turn: {
  readonly sequence: number;
  readonly turnId: string;
}) {
  return createTurnStartedEvent(turn);
}

export function stepStartedForResolvers(step: {
  readonly modelId: string;
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}) {
  return createStepStartedEvent(step);
}
