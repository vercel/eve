/**
 * Workflow-owned abort controls prepared before a turn begins. One that no
 * turn uses is left open, as a finished turn's are: nothing listens to it,
 * so aborting it would only add Workflow writes.
 */
export interface TurnControl {
  readonly cancellation: AbortController;
  readonly steering: AbortController;
}

export function createTurnControl(): TurnControl {
  return { cancellation: new AbortController(), steering: new AbortController() };
}

/**
 * The controls the next turn starts with. Only a running turn aborts its controls, so the ones
 * `used` left unaborted serve the next turn as well as new ones; only an aborted one is replaced.
 * Each new one registers a Workflow abort hook between turns, which a message that arrives as the
 * turn settles would wait behind.
 */
export function nextTurnControl(used: TurnControl): TurnControl {
  return {
    cancellation: used.cancellation.signal.aborted ? new AbortController() : used.cancellation,
    steering: used.steering.signal.aborted ? new AbortController() : used.steering,
  };
}
