import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler } from "#channel/adapter.js";
import { dispatchStreamEventHooks } from "#context/hook-lifecycle.js";
import { withContextScope } from "#context/run-step.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { setChannelContext } from "#execution/channel-context.js";
import { observeSessionActivity } from "#execution/session-activity-projection.js";
import {
  createDurableSessionState,
  type DurableSessionState,
  readDurableSession,
} from "#execution/durable-session-store.js";
import { hydrateDurableSession } from "#execution/session.js";
import { reconcileSessionContinuationToken } from "#execution/reconcile-session-continuation-token.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import { emitCancelledTurn } from "#harness/cancelled-turn-emission.js";
import { clearPendingSessionLimitPrompt } from "#harness/input-requests.js";
import {
  getHarnessEmissionState,
  isHarnessBetweenTurns,
  setHarnessEmissionState,
} from "#harness/emission.js";
import {
  clearAllProxyInputRequests,
  getProxyInputRequests,
  hasProxyInputRequests,
} from "#harness/proxy-input-requests.js";
import {
  abandonRunningAgentTurns,
  applyTaskAgentHandleCommand,
} from "#subagents/handles/transitions.js";
import { clearPendingCoordinationBatch } from "#harness/coordination.js";
import { clearWorkflowToolRuns, getWorkflowToolRuns } from "#harness/workflow-tool-runs.js";
import { bindSessionInstrumentation } from "#instrumentation/runtime.js";
import { getTurnUsageState, toUsage } from "#harness/turn-tag-state.js";
import { clearPendingWorkflowInterrupt } from "#harness/workflow-interrupt-state.js";
import {
  encodeMessageStreamEvent,
  type UnstampedMessageStreamEvent,
  stampMessageStreamEvent,
} from "#protocol/message.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import type { TokenUsage } from "#shared/token-usage.js";

export interface CancelledTurnSettleResult {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly usage?: TokenUsage;
}

/**
 * Settles one cancelled turn: emits `turn.cancelled` → `session.waiting`,
 * drops pending coordination state, and persists the between-turns
 * session. Runs in the *driver* run, whose wake sources exclude the
 * cancel hook, so a queued cancel wake cannot re-dispatch it.
 */
export async function settleCancelledTurnStep(input: {
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<CancelledTurnSettleResult> {
  "use step";

  const durableSession = await readDurableSession(input.sessionState);
  const ctx = await deserializeContext(input.serializedContext);
  const adapter = ctx.require(ChannelKey);
  const adapterCtx = buildAdapterContext(adapter, ctx);
  const bundle = ctx.require(BundleKey);
  const effectiveAgent = resolveEffectiveAgentRuntime(bundle, ctx);

  let session = hydrateDurableSession({
    compactionOverrides: {
      thresholdPercent: effectiveAgent.thresholdPercent,
    },
    durable: durableSession,
    turnAgent: effectiveAgent.turnAgent,
  });
  const instrumentation = bindSessionInstrumentation({
    agentName: effectiveAgent.turnAgent.id,
    ctx,
    rootSessionId: session.rootSessionId ?? session.sessionId,
    sessionId: session.sessionId,
  });

  let emissionState = getHarnessEmissionState(durableSession.state);
  // A descendant HITL wait already streamed this turn's waiting boundary
  // (the proxy epilogue clears the turn id); re-emitting would fabricate
  // a turn id and duplicate the boundary.
  const proxyRequests = getProxyInputRequests(durableSession.state);
  const stoppedAtDescendantLimit = [...proxyRequests.values()].some(
    (request) => request.kind === "session-limit",
  );
  const alreadyEpilogued =
    isHarnessBetweenTurns(session) &&
    hasProxyInputRequests(durableSession.state) &&
    !stoppedAtDescendantLimit;

  if (!alreadyEpilogued) {
    const writer = input.parentWritable.getWriter();
    try {
      const scoped = await withContextScope(ctx, session, async (enrichedSession) => {
        const baseEmit = async (event: UnstampedMessageStreamEvent): Promise<void> => {
          const transformed = await callAdapterEventHandler(adapter, event, adapterCtx);
          setChannelContext(ctx, { ...adapter, state: { ...adapterCtx.state } });
          // Stamp once: the persisted chunk and the hooks must agree on the id.
          const stamped = stampMessageStreamEvent(transformed);
          await writer.write(encodeMessageStreamEvent(stamped));
          void observeSessionActivity({ ctx, event: stamped, sessionId: session.sessionId });
          await dispatchStreamEventHooks({
            ctx,
            event: stamped,
            registry: bundle.hookRegistry,
          });
        };
        const emit =
          instrumentation?.createHandleEvent({
            handleEvent: baseEmit,
            turnId: activeTurnId(emissionState),
          }) ?? baseEmit;
        return {
          result: await emitCancelledTurn(emit, emissionState),
          session: enrichedSession,
        };
      });
      emissionState = scoped.result;
      session = scoped.session;
    } finally {
      await instrumentation?.flush();
      writer.releaseLock();
    }
  }

  // `clearPendingSessionLimitPrompt`: cancellation settles with the step's
  // input snapshot, which can resurrect an already-answered session-limit
  // prompt (the decline that cancelled this turn consumed the answer in the
  // discarded turn state). The pre-model gate re-raises the prompt while the
  // violation holds, so the next delivery gets a fresh prompt instead of
  // queueing forever behind a stale one.
  //
  // `abandonRunningAgentTurns`: `cancelDescendantTurnsStep` already ran and
  // the cancelled turn's inbox is gone, so a child settlement can never
  // reach this store again. This is the last write that can move those
  // handles out of `running`.
  const workflowToolRuns = getWorkflowToolRuns(session.state);
  for (const run of workflowToolRuns) {
    session = applyTaskAgentHandleCommand(session, {
      kind: "release-owner",
      lastStatus: "(cancelled)",
      ownerId: run.runId,
    }).session;
  }
  const cancelledSession = reconcileSessionContinuationToken(
    ctx,
    setHarnessEmissionState(
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
    ),
  );
  const totals = getTurnUsageState(session.state)?.session;

  const base = {
    serializedContext: serializeContext(ctx),
    sessionState: createDurableSessionState({ session: cancelledSession }),
  };
  return totals === undefined ? base : { ...base, usage: toUsage(totals) };
}
