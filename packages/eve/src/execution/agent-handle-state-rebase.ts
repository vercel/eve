import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { TurnDriverAction } from "#execution/turn-control-receiver.js";
import { mergeTaskOwnedAgentHandlesIntoTurnState } from "#subagents/handles/query.js";

/** Preserves handle leases accepted by the driver against a turn's older snapshot. */
export function rebaseTaskAgentHandleMutations(
  action: TurnDriverAction,
  driverState: DurableSessionState,
): TurnDriverAction {
  const snapshot = action.sessionState.snapshot;
  if (snapshot === undefined) {
    throw new Error(
      "Cannot merge task-owned agent handles into a session state without a snapshot.",
    );
  }
  return {
    ...action,
    sessionState: {
      ...action.sessionState,
      snapshot: {
        ...snapshot,
        session: {
          ...snapshot.session,
          state: mergeTaskOwnedAgentHandlesIntoTurnState({
            driverState: driverState.snapshot?.session.state,
            turnState: snapshot.session.state,
          }),
        },
      },
    },
  };
}
