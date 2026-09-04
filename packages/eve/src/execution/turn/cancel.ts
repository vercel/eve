import type { DurableSessionState } from "#execution/session/state.js";
import { createDurableSessionState } from "#execution/session/state.js";
import { deserializeContext } from "#context/serialize.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { hydrateDurableSession } from "#execution/session.js";
import { finalizeModelSettlement } from "#execution/turn/finalize-model.js";
import type { ModelSettlement } from "#execution/turn/model-types.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import { getHarnessEmissionState, setHarnessEmissionState } from "#harness/emission.js";
import { clearPendingSessionLimitPrompt } from "#harness/input-requests.js";
import { clearAllProxyInputRequests } from "#harness/proxy-input-requests.js";
import {
  abandonAgentInvocationOwners,
  abandonRunningAgentTurns,
} from "#subagents/handles/transitions.js";
import { clearPendingCoordinationBatch } from "#harness/coordination.js";
import { clearWorkflowToolRuns, getWorkflowToolRuns } from "#harness/workflow-tool-runs.js";
import { getTurnUsageState, toUsage } from "#harness/turn-tag-state.js";
import { clearPendingWorkflowInterrupt } from "#harness/workflow-interrupt-state.js";
import {
  createSessionWaitingEvent,
  createTurnCancelledEvent,
  createTurnInterruptedEvent,
  stampMessageStreamEvent,
} from "#protocol/message.js";
import type { TokenUsage } from "#shared/token-usage.js";

export function cancellationSettlement(
  state: DurableSessionState,
  kind: "cancel" | "interrupt" | "terminal",
): ModelSettlement {
  const emission = state.emissionState;
  const identity = { sequence: emission.sequence, turnId: activeTurnId(emission) };
  return {
    events: [
      kind === "interrupt"
        ? createTurnInterruptedEvent(identity)
        : createTurnCancelledEvent(identity),
      ...(kind === "cancel" ? [createSessionWaitingEvent()] : []),
    ].map(stampMessageStreamEvent),
    emissionAfter: {
      sessionStarted: true,
      sequence: emission.sequence + 1,
      stepIndex: 0,
      turnId: "",
    },
  };
}

/** Clears abandoned domain work and commits cancellation through the normal lifecycle. */
export async function settleCancelledTurn(input: {
  readonly events: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly settlement: ModelSettlement;
}): Promise<{
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly usage?: TokenUsage;
}> {
  const ctx = await deserializeContext(input.serializedContext);
  const effectiveAgent = resolveEffectiveAgentRuntime(ctx.require(BundleKey), ctx);
  let session = hydrateDurableSession({
    durable: input.sessionState.snapshot.session,
    turnAgent: effectiveAgent.turnAgent,
    compactionOverrides: { thresholdPercent: effectiveAgent.thresholdPercent },
  });
  const emissionState = getHarnessEmissionState(session.state);
  // Discarded model state may contain an already-answered prompt; the next
  // model gate must issue a fresh prompt if the limit still applies.
  const workflowToolRuns = getWorkflowToolRuns(session.state);
  session = abandonAgentInvocationOwners(
    session,
    new Set(workflowToolRuns.map((run) => run.runId)),
  );
  const cancelledSession = setHarnessEmissionState(
    clearPendingSessionLimitPrompt(
      clearAllProxyInputRequests(
        clearPendingWorkflowInterrupt(
          clearPendingCoordinationBatch(
            clearWorkflowToolRuns(
              abandonRunningAgentTurns({ ...session, outputSchema: undefined }),
            ),
          ),
        ),
      ),
    ),
    emissionState,
  );
  const totals = getTurnUsageState(session.state)?.session;
  const result = await finalizeModelSettlement({
    ...input,
    sessionState: createDurableSessionState({ session: cancelledSession }),
  });
  return { ...result, usage: totals === undefined ? undefined : toUsage(totals) };
}
