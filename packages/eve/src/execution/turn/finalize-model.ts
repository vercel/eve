import { withContextScope } from "#context/run-step.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { HandleEventKey } from "#context/keys.js";
import { rebindMissingCompiledDynamicToolCallbacks } from "#context/dynamic-tool-lifecycle.js";
import { bindDynamicConnections } from "#execution/dynamic-connections.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { createExecutionHistoryView } from "#execution/history-view.js";
import { buildRuntimeIdentity } from "#execution/node-step.js";
import { reconcileSessionContinuationToken } from "#execution/reconcile-session-continuation-token.js";
import { hydrateDurableSession } from "#execution/session.js";
import { createDurableSessionState, type DurableSessionState } from "#execution/session/state.js";
import { bindTurnEvents } from "#execution/turn/events.js";
import type { ModelSettlement } from "#execution/turn/model-types.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import { getHarnessEmissionState, setHarnessEmissionState } from "#harness/emission.js";
import { bindSessionInstrumentation } from "#instrumentation/runtime.js";
import { createTurnStartedEvent } from "#protocol/message.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";

/** Runs only after the owner commits to the proposal and stops accepting steering. */
export async function finalizeModelSettlement(input: {
  readonly events: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly settlement: ModelSettlement;
}): Promise<{
  readonly sessionState: DurableSessionState;
  readonly serializedContext: Record<string, unknown>;
}> {
  const ctx = await deserializeContext(input.serializedContext);
  const bundle = ctx.require(BundleKey);
  const effectiveAgent = resolveEffectiveAgentRuntime(bundle, ctx);
  const session = hydrateDurableSession({
    durable: input.sessionState.snapshot.session,
    turnAgent: effectiveAgent.turnAgent,
    compactionOverrides: { thresholdPercent: effectiveAgent.thresholdPercent },
  });
  const emissionState = getHarnessEmissionState(session.state);
  const history = createExecutionHistoryView(session);
  const instrumentation = bindSessionInstrumentation({
    agentName: effectiveAgent.turnAgent.id,
    ctx,
    rootSessionId: session.rootSessionId ?? session.sessionId,
    sessionId: session.sessionId,
  });
  const sink = bindTurnEvents({ ctx, events: input.events, session });
  try {
    const scoped = await withContextScope(ctx, session, async (enrichedSession) => {
      const handleEvent =
        instrumentation?.createHandleEvent({
          handleEvent: sink.handleEvent,
          turnId: activeTurnId(emissionState),
        }) ?? sink.handleEvent;
      ctx.setVirtualContext(HandleEventKey, handleEvent);
      await bindDynamicConnections(ctx, bundle.resolvedAgent).rehydrate(
        emissionState,
        buildRuntimeIdentity({ ...bundle.graph.root, turnAgent: effectiveAgent.turnAgent }),
        false,
      );
      await rebindMissingCompiledDynamicToolCallbacks({
        ctx,
        event: createTurnStartedEvent({
          sequence: emissionState.sequence,
          turnId: activeTurnId(emissionState),
        }),
        messages: history.initial.messages,
        resolvers: bundle.resolvedAgent.dynamicToolResolvers ?? [],
      });
      for (const event of input.settlement.events)
        await handleEvent(event, history.initial.messages);
      return {
        result: undefined,
        session: setHarnessEmissionState(enrichedSession, input.settlement.emissionAfter),
      };
    });
    return {
      sessionState: createDurableSessionState({
        session: reconcileSessionContinuationToken(ctx, scoped.session),
      }),
      serializedContext: serializeContext(ctx),
    };
  } finally {
    sink.release();
    await instrumentation?.flush();
  }
}
