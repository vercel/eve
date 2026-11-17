export interface TurnControl {
  readonly cancellation: AbortController;
  readonly steering: AbortController;
}

export function createTurnControl(): TurnControl {
  return { cancellation: new AbortController(), steering: new AbortController() };
}
