import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler } from "#channel/adapter.js";
import { dispatchStreamEventHooks } from "#context/hook-lifecycle.js";
import { withContextScope } from "#context/run-step.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { setChannelContext } from "#execution/channel-context.js";
import {
  createDurableSessionState,
  type DurableSessionState,
  readDurableSession,
} from "#execution/durable-session-store.js";
import { hydrateDurableSession } from "#execution/session.js";
import { reconcileSessionContinuationToken } from "#execution/reconcile-session-continuation-token.js";
import { emitCancelledTurn } from "#harness/cancelled-turn-emission.js";
import { getHarnessEmissionState, setHarnessEmissionState } from "#harness/emission.js";
import {
  clearAllProxyInputRequests,
  hasProxyInputRequests,
} from "#harness/proxy-input-requests.js";
import { clearPendingRuntimeActionBatch } from "#harness/runtime-actions.js";
import { clearPendingWorkflowInterrupt } from "#harness/workflow-interrupt-state.js";
import {
  encodeMessageStreamEvent,
  type HandleMessageStreamEvent,
  timestampHandleMessageStreamEvent,
} from "#protocol/message.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

export interface CancelledTurnSettleResult {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

/**
 * Settles one cancelled turn: emits `turn.cancelled` → `session.waiting`,
 * drops pending runtime-action state, and persists the between-turns
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

  let session = hydrateDurableSession({
    compactionOverrides: {
      thresholdPercent: bundle.resolvedAgent.config.compaction?.thresholdPercent,
    },
    durable: durableSession,
    turnAgent: bundle.turnAgent,
  });

  let emissionState = getHarnessEmissionState(durableSession.state);
  // A descendant HITL wait already streamed this turn's waiting boundary
  // (the proxy epilogue clears the turn id); re-emitting would fabricate
  // a turn id and duplicate the boundary.
  const alreadyEpilogued =
    emissionState.turnId === "" && hasProxyInputRequests(durableSession.state);

  if (!alreadyEpilogued) {
    const writer = input.parentWritable.getWriter();
    try {
      const scoped = await withContextScope(ctx, session, async (enrichedSession) => {
        const emit = async (event: HandleMessageStreamEvent): Promise<void> => {
          const transformed = await callAdapterEventHandler(adapter, event, adapterCtx);
          setChannelContext(ctx, { ...adapter, state: { ...adapterCtx.state } });
          await writer.write(
            encodeMessageStreamEvent(timestampHandleMessageStreamEvent(transformed)),
          );
          await dispatchStreamEventHooks({
            ctx,
            event: transformed,
            registry: bundle.hookRegistry,
          });
        };
        return { result: await emitCancelledTurn(emit, emissionState), session: enrichedSession };
      });
      emissionState = scoped.result;
      session = scoped.session;
    } finally {
      writer.releaseLock();
    }
  }

  const cancelledSession = reconcileSessionContinuationToken(
    ctx,
    setHarnessEmissionState(
      clearAllProxyInputRequests(
        clearPendingWorkflowInterrupt(clearPendingRuntimeActionBatch(session)),
      ),
      emissionState,
    ),
  );

  return {
    serializedContext: serializeContext(ctx),
    sessionState: createDurableSessionState({ session: cancelledSession }),
  };
}
