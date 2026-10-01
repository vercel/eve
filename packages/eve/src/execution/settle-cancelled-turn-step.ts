import {
  commitCancelledCoordinationBatch,
  getPendingCoordinationBatch,
} from "#harness/coordination.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import {
  publishFromSessionStep,
  restoreSessionStep,
  type SessionHistoryStepState,
} from "#execution/publish-session-events.js";
import {
  withSessionStateDelta,
  type WithSessionStateDelta,
} from "#execution/session/state-delta.js";
import { relayWithdrawnRequests } from "#execution/tools/workflow/withdraw-step.js";
import { emitCancelledTurn } from "#harness/cancelled-turn-emission.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import { clearPendingSessionLimitPrompt } from "#harness/input-requests.js";
import { getHarnessEmissionState, setHarnessEmissionState } from "#harness/emission.js";
import { removeBlockingWorkflowToolRuns } from "#harness/workflow-tool-runs.js";
import {
  getSessionUsage,
  getTurnUsageState,
  takeSessionUsageDelta,
} from "#harness/turn-tag-state.js";
import type { TokenUsage } from "#shared/token-usage.js";

export interface CancelledTurnSettleResult {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly history: HarnessModelMessage[];
  /** What the session spent since its caller's last report, when asked to report it. */
  readonly usage?: TokenUsage;
}

/** Takes the history because the turn's pending calls move into it, each answered as cancelled. */
interface CancelledTurnSettleInput extends SessionHistoryStepState {
  /**
   * Whether a caller receives the turn's usage. Only then is it marked
   * reported; otherwise the next settled turn reports it.
   */
  readonly reportUsage: boolean;
}

/**
 * Settles one cancelled turn: relays `input.resolved` for every request the
 * session proxies, emits `turn.cancelled` → `session.waiting`, drops pending
 * coordination state, and persists the between-turns session. Runs in the
 * owner, whose wake sources exclude the cancel hook, so a queued cancel wake
 * cannot re-dispatch it.
 */
export async function settleCancelledTurnStep(
  input: CancelledTurnSettleInput,
): Promise<WithSessionStateDelta<CancelledTurnSettleResult>> {
  "use step";
  return await withSessionStateDelta(input, settleCancelledTurn);
}

/** {@link settleCancelledTurnStep} for a caller that is already a step and adopts the whole state. */
export async function settleCancelledTurn(
  input: CancelledTurnSettleInput,
): Promise<CancelledTurnSettleResult> {
  // The cancel stopped every descendant and task, so nobody can answer a request the session relays.
  const relayed = await relayWithdrawnRequests(input, () => true);
  const step = {
    ...(await restoreSessionStep({ ...relayed, sessionWritable: input.sessionWritable })),
    history: input.history,
  };
  const durableState = step.durableSession.state;
  const { published, result: usage } = await publishFromSessionStep(step, {
    origin: "own",
    publish: (emit) =>
      emitCancelledTurn(
        emit,
        getHarnessEmissionState(durableState),
        getSessionUsage(step.durableSession),
      ),
    updateSession(session, emissionState) {
      // `clearPendingSessionLimitPrompt`: cancellation settles with the step's
      // input snapshot, which can resurrect an already-answered session-limit
      // prompt (the decline that cancelled this turn consumed the answer in the
      // discarded turn state). The pre-model gate re-raises the prompt while the
      // violation holds, so the next delivery gets a fresh prompt instead of
      // queueing forever behind a stale one.
      const owningTurnId =
        getPendingCoordinationBatch(session.state)?.event.turnId ??
        input.sessionState.emissionState.turnId;
      const cancelledSession = setHarnessEmissionState(
        clearPendingSessionLimitPrompt(
          commitCancelledCoordinationBatch(
            removeBlockingWorkflowToolRuns({ ...session, outputSchema: undefined }, owningTurnId),
          ),
        ),
        emissionState,
      );
      if (!input.reportUsage || getTurnUsageState(session.state) === undefined) {
        return { session: cancelledSession };
      }
      // Reported like a settled turn, as usage since the last report, so the
      // caller counts each turn once whether it settled or was cancelled.
      const reported = takeSessionUsageDelta(cancelledSession);
      return { result: reported.delta, session: reported.session };
    },
  });
  return usage === undefined ? published : { ...published, usage };
}
