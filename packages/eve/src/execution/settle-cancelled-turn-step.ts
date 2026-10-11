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
import { retireCancelledCandidates } from "#harness/hitl/index.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import { cancel } from "#harness/session-machine/transitions.js";
import { applyTransition, sessionView } from "#harness/session-machine/commit.js";
import { currentProjection } from "#harness/session-machine/current.js";
import { runtimeWait, storedProjection } from "#harness/session-machine/view.js";
import { removeBlockingWorkflowToolRuns } from "#harness/workflow-tool-runs.js";
import { getTurnUsageState, takeSessionUsageDelta } from "#harness/turn-tag-state.js";
import type { TokenUsage } from "#shared/token-usage.js";

export interface CancelledTurnSettleResult {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly history: HarnessModelMessage[];
  /** What the session spent since its caller's last report, when asked to report it. */
  readonly usage?: TokenUsage;
}

/** Takes the history because the steps the cancel stopped commit to it. */
interface CancelledTurnSettleInput extends SessionHistoryStepState {
  /**
   * Whether a caller receives the turn's usage. Only then is it marked
   * reported; otherwise the next settled turn reports it.
   */
  readonly reportUsage: boolean;
}

/**
 * Settles one cancelled turn through the machine's `cancel`, and persists
 * the between-turns session. Runs in the owner, whose wake sources exclude the
 * cancel hook, so a queued cancel wake cannot re-dispatch it.
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
  const step = { ...(await restoreSessionStep(input)), history: input.history };
  const durableState = step.durableSession.state;
  const owningTurnId =
    runtimeWait(durableState)?.event.turnId ?? storedProjection(durableState).activeTurnId ?? "";
  const { published, result: usage } = await publishFromSessionStep(step, {
    origin: "own",
    publish: (emit, session) =>
      applyTransition(
        session,
        cancel(sessionView(currentProjection(step.ctx), session.state)),
        emit,
      ),
    updateSession(_session, cancelled) {
      // The cancel reported every request and call it closed and committed the steps it stopped;
      // what remains is private: its runs are forgotten, and its responders stop.
      const cancelledSession = removeBlockingWorkflowToolRuns(
        retireCancelledCandidates({ ...cancelled, outputSchema: undefined }),
        owningTurnId,
      );
      if (!input.reportUsage || getTurnUsageState(cancelled.state) === undefined) {
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
