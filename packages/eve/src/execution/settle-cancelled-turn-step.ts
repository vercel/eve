import {
  commitCancelledCoordinationBatch,
  getPendingCoordinationBatch,
} from "#harness/coordination.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import {
  createDurableSessionState,
  type DurableSessionState,
  readDurableSession,
} from "#execution/durable-session-store.js";
import { withSessionEventEmitter } from "#execution/publish-session-events.js";
import { reconcileSessionContinuationToken } from "#execution/reconcile-session-continuation-token.js";
import { emitCancelledTurn } from "#harness/cancelled-turn-emission.js";
import { clearPendingSessionLimitPrompt } from "#harness/input-requests.js";
import { getHarnessEmissionState, setHarnessEmissionState } from "#harness/emission.js";
import { clearAllProxyInputRequests } from "#harness/proxy-input-requests.js";
import { removeBlockingWorkflowToolRuns } from "#harness/workflow-tool-runs.js";
import { getTurnUsageState, toUsage } from "#harness/turn-tag-state.js";
import type { TokenUsage } from "#shared/token-usage.js";

export interface CancelledTurnSettleResult {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly usage?: TokenUsage;
}

/**
 * Settles one cancelled turn: emits `turn.cancelled` → `session.waiting`,
 * drops pending coordination state, and persists the between-turns
 * session. Runs in the owner, whose wake sources exclude the
 * cancel hook, so a queued cancel wake cannot re-dispatch it.
 */
export async function settleCancelledTurnStep(input: {
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<CancelledTurnSettleResult> {
  "use step";

  const durableSession = readDurableSession(input.sessionState);
  const ctx = await deserializeContext(input.serializedContext);
  const emitted = await withSessionEventEmitter(
    { ctx, durableSession, origin: "own", sessionWritable: input.sessionWritable },
    async (emit, scopedSession) => ({
      result: await emitCancelledTurn(emit, getHarnessEmissionState(durableSession.state)),
      session: scopedSession,
    }),
  );
  const emissionState = emitted.result;
  const session = emitted.session;

  // `clearPendingSessionLimitPrompt`: cancellation settles with the step's
  // input snapshot, which can resurrect an already-answered session-limit
  // prompt (the decline that cancelled this turn consumed the answer in the
  // discarded turn state). The pre-model gate re-raises the prompt while the
  // violation holds, so the next delivery gets a fresh prompt instead of
  // queueing forever behind a stale one.
  const owningTurnId =
    getPendingCoordinationBatch(session.state)?.event.turnId ??
    input.sessionState.emissionState.turnId;
  const cancelledSession = reconcileSessionContinuationToken(
    ctx,
    setHarnessEmissionState(
      clearPendingSessionLimitPrompt(
        clearAllProxyInputRequests(
          commitCancelledCoordinationBatch(
            removeBlockingWorkflowToolRuns({ ...session, outputSchema: undefined }, owningTurnId),
          ),
        ),
      ),
      emissionState,
    ),
  );
  const totals = getTurnUsageState(session.state)?.session;

  const base = {
    serializedContext: serializeContext(ctx),
    sessionState: createDurableSessionState({ session: cancelledSession }),
  };
  return totals === undefined ? base : { ...base, usage: toUsage(totals) };
}
