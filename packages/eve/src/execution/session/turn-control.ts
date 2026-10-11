/** Workflow-owned abort controls prepared before a turn begins. */
export interface TurnControl {
  readonly cancellation: AbortController;
  readonly steering: AbortController;
  dispose(): void;
}

export function createTurnControl(): TurnControl {
  const cancellation = new AbortController();
  const steering = new AbortController();
  return {
    cancellation,
    steering,
    dispose() {
      cancellation.abort();
      steering.abort();
    },
  };
}
