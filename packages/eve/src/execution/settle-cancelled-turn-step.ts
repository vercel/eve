import type { ModelMessage } from "ai";

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
import { emitCancelledTurn } from "#harness/cancelled-turn-emission.js";
import { HumanInput, type Transition } from "#harness/human-input/index.js";
import { type HarnessModelMessage, validateHarnessModelMessages } from "#harness/messages.js";
import { applyHumanInputEvents } from "#harness/human-input/effects/index.js";
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
 * Settles one cancelled turn: tells human input the turn was cancelled, emits
 * `turn.cancelled` → `session.waiting`, drops pending coordination state, and
 * persists the between-turns session. Runs in the owner, whose wake sources
 * exclude the cancel hook, so a queued cancel wake cannot re-dispatch it.
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
  const step = {
    ...(await restoreSessionStep(input)),
    history: input.history,
  };
  const durableState = step.durableSession.state;
  let transition: Transition | undefined;
  let cancelledResults: readonly ModelMessage[] = [];
  const { published, result: usage } = await publishFromSessionStep(step, {
    origin: "own",
    async publish(emit) {
      transition = HumanInput.read(durableState).intake({ type: "cancelled" });
      const { ending, history } = await applyHumanInputEvents(emit, transition.events);
      // The turn already ends as cancelled; a failure here has no turn left to fail.
      if (ending?.kind === "failed") throw new Error(ending.message);
      cancelledResults = history;
      const emissionState = getHarnessEmissionState(durableState);
      return await emitCancelledTurn(emit, emissionState, getSessionUsage(step.durableSession));
    },
    updateSession(baseSession, emissionState) {
      const session = {
        ...baseSession,
        state: transition?.humanInput.write(baseSession.state) ?? baseSession.state,
      };
      const owningTurnId =
        getPendingCoordinationBatch(session.state)?.event.turnId ??
        input.sessionState.emissionState.turnId;
      // After the batch, which may hold the response that made the cancelled calls.
      const committed = commitCancelledCoordinationBatch(
        removeBlockingWorkflowToolRuns({ ...session, outputSchema: undefined }, owningTurnId),
      );
      const cancelledSession = setHarnessEmissionState(
        {
          ...committed,
          history: validateHarnessModelMessages([...committed.history, ...cancelledResults]),
        },
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
