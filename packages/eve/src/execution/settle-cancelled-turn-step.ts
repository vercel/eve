import { processApp } from "#runtime/app.js";
import { activeTurnIdOf } from "#protocol/session-projection.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import {
  publishFromSessionStep,
  restoreSessionStep,
  type Entered,
  type SessionHistoryStepInput,
} from "#execution/publish-session-events.js";
import { type WithSessionStateDelta } from "#execution/session/state-delta.js";
import { withSessionStateDelta } from "#execution/session/step-state-delta.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import { cancel, controlled } from "#harness/session-machine/transitions.js";
import type { ControlDelivery } from "#harness/types.js";
import { applyTransition, saveTransition, sessionView } from "#harness/session-machine/commit.js";
import { runtimeWait, storedProjection } from "#harness/session-machine/view.js";
import { removeBlockingWorkflowToolRuns } from "#harness/workflow-tool-runs.js";
import { sessionUsage, takeSessionUsageDelta } from "#harness/session-usage.js";
import type { TokenUsage } from "#shared/token-usage.js";

export interface CancelledTurnSettleResult {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly history: HarnessModelMessage[];
  readonly usage?: TokenUsage;
}

interface CancelledTurnSettleInput extends SessionHistoryStepInput {
  readonly reportUsage: boolean;
  readonly control?: ControlDelivery;
}

export async function settleCancelledTurnStep(
  input: CancelledTurnSettleInput,
): Promise<WithSessionStateDelta<CancelledTurnSettleResult>> {
  "use step";
  return await withSessionStateDelta(processApp().hosts, input, settleCancelledTurn);
}

export async function settleCancelledTurn(
  input: Entered<CancelledTurnSettleInput>,
): Promise<CancelledTurnSettleResult> {
  const step = { ...(await restoreSessionStep(input)), history: input.history };
  const durableState = step.durableSession.state;
  const owningTurnId =
    runtimeWait(durableState)?.event.turnId ?? activeTurnIdOf(storedProjection(durableState)) ?? "";
  const transition = controlled(input.control, "cancel", (cause) =>
    cancel(sessionView(storedProjection(durableState), durableState), { cause }),
  );
  const { published, result: usage } = await publishFromSessionStep(step, {
    origin: "own",
    publish: (emit, session) => applyTransition(session, transition, emit),
    updateSession(_session, cancelled) {
      const settled = cancelled ?? saveTransition(_session, transition);
      const cancelledSession = removeBlockingWorkflowToolRuns(
        { ...settled, outputSchema: undefined },
        owningTurnId,
      );
      const spent = sessionUsage(settled);
      const spentNothing =
        spent.inputTokens + spent.outputTokens + spent.cacheReadTokens + spent.cacheWriteTokens ===
          0 && spent.costUsd === undefined;
      if (!input.reportUsage || spentNothing) {
        return { session: cancelledSession };
      }
      const reported = takeSessionUsageDelta(cancelledSession);
      return { result: reported.delta, session: reported.session };
    },
  });
  return usage === undefined ? published : { ...published, usage };
}
