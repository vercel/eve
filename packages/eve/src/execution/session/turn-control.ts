export interface TurnControl {
  readonly cancellation: AbortController;
  readonly steering: AbortController;
}

export function createTurnControl(): TurnControl {
  return { cancellation: new AbortController(), steering: new AbortController() };
}

export function nextTurnControl(used: TurnControl): TurnControl {
  return {
    cancellation: used.cancellation.signal.aborted ? new AbortController() : used.cancellation,
    steering: used.steering.signal.aborted ? new AbortController() : used.steering,
  };
}
