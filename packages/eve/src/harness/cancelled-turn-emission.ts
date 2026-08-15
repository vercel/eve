import { createSessionWaitingEvent, createTurnCancelledEvent } from "#protocol/message.js";
import type { HarnessEmitFn } from "#harness/types.js";

import { activeTurnId } from "#harness/active-turn-id.js";
import type { HarnessEmissionState } from "#harness/emission.js";

/**
 * Emits the cancelled-turn epilogue: `turn.cancelled` → `session.waiting`
 * (never a failure event) and returns the between-turns emission state.
 *
 * `state` is the last *persisted* emission state, which may predate the
 * cancelled turn's preamble — the turn id is reconstructed via
 * {@link activeTurnId} and `sessionStarted` is stamped `true`.
 */
export async function emitCancelledTurn(
  emitFn: HarnessEmitFn,
  state: HarnessEmissionState,
): Promise<HarnessEmissionState> {
  await emitFn(
    createTurnCancelledEvent({
      sequence: state.sequence,
      turnId: activeTurnId(state),
    }),
  );
  await emitFn(createSessionWaitingEvent());

  return {
    sessionStarted: true,
    sequence: state.sequence + 1,
    stepIndex: 0,
    turnId: "",
  };
}
