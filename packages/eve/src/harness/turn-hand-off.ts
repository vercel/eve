import type { ModelMessage } from "ai";
import type { SessionAuthContext } from "#channel/types.js";
import { principalOf } from "#execution/session/principal.js";
import type { HarnessEmissionState } from "#harness/emission-state.js";
import { getPendingInputBatches } from "#harness/pending-input-batches.js";
import type { HarnessEmitFn, SessionStateMap } from "#harness/types.js";
import { createTurnCompletedEvent } from "#protocol/message.js";

/**
 * Whether someone other than the person whose turn raised a request answered
 * it. A turn has one principal, so that answer cannot resume the held turn:
 * it ends, and the answered work runs in the responder's own turn.
 */
export function answeredByAnotherPrincipal(input: {
  readonly answeredRequestIds: readonly string[];
  readonly responder: SessionAuthContext | null;
  /** Session state from before the answer resolved its batch. */
  readonly state: SessionStateMap | undefined;
}): boolean {
  const answered = new Set(input.answeredRequestIds);
  const responder = principalOf(input.responder);
  return getPendingInputBatches(input.state).some(
    (batch) =>
      batch.requester !== undefined &&
      batch.requests.some((request) => answered.has(request.requestId)) &&
      principalOf(batch.requester) !== responder,
  );
}

/** Completes the held turn so the next preamble starts the responder's turn. */
export async function endTurnForHandOff(
  emit: HarnessEmitFn,
  state: HarnessEmissionState,
  messages: readonly ModelMessage[],
): Promise<HarnessEmissionState> {
  await emit(
    createTurnCompletedEvent({ sequence: state.sequence, turnId: state.turnId }),
    messages,
  );
  return {
    sessionStarted: state.sessionStarted,
    sequence: state.sequence + 1,
    stepIndex: 0,
    turnId: "",
  };
}
