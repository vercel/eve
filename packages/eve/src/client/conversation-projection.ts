import { initialSessionProjection, type SessionProjection } from "#protocol/session-projection.js";

const projectionKey = Symbol("eve.conversationProjection");

/** Keep event-contract details off the public state shape; reducers carry this hidden state forward. */
export function conversationProjection(state: object): SessionProjection {
  return (
    (state as { [projectionKey]?: SessionProjection })[projectionKey] ?? initialSessionProjection()
  );
}

export function withConversationProjection<T extends object>(
  state: T,
  projection: SessionProjection,
): T {
  if ((state as { [projectionKey]?: SessionProjection })[projectionKey] === projection)
    return state;
  return Object.defineProperty({ ...state }, projectionKey, { value: projection });
}
