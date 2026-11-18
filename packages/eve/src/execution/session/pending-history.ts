import type { SessionStateMap } from "#harness/types.js";
import type { SessionHistoryMessage } from "#shared/session-history.js";

const PENDING_HISTORY_STATE_KEY = "eve.session.pendingHistory";

export function withPendingHistory(
  state: SessionStateMap | undefined,
  history: readonly SessionHistoryMessage[] | undefined,
): SessionStateMap | undefined {
  if (history === undefined || history.length === 0) return state;
  return { ...state, [PENDING_HISTORY_STATE_KEY]: history };
}

export function readPendingHistory(
  state: SessionStateMap | undefined,
): readonly SessionHistoryMessage[] {
  return (state?.[PENDING_HISTORY_STATE_KEY] as readonly SessionHistoryMessage[] | undefined) ?? [];
}

export function withoutPendingHistory(
  state: SessionStateMap | undefined,
): SessionStateMap | undefined {
  if (state === undefined || !(PENDING_HISTORY_STATE_KEY in state)) return state;
  const { [PENDING_HISTORY_STATE_KEY]: _pending, ...rest } = state;
  return rest;
}
