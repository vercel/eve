/**
 * Workflow-owned abort controls prepared before a turn begins. One that no
 * turn uses is left alone, as a finished turn's are: aborting it would only
 * add Workflow writes, and the run's end closes its hooks.
 */
export interface TurnControl {
  readonly cancellation: AbortController;
  readonly steering: AbortController;
}

export function createTurnControl(): TurnControl {
  return { cancellation: new AbortController(), steering: new AbortController() };
}
