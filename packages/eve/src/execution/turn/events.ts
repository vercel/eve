import { withContextScope } from "#context/run-step.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { HandleEventKey } from "#context/keys.js";
import { hydrateDurableSession } from "#execution/session.js";
import { createDurableSessionState, type DurableSessionState } from "#execution/session/state.js";
import { reconcileSessionContinuationToken } from "#execution/reconcile-session-continuation-token.js";
import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler } from "#channel/adapter.js";
import type { ContextContainer } from "#context/container.js";
import { dispatchDynamicInstructionEvent } from "#context/dynamic-instruction-lifecycle.js";
import { dispatchDynamicModelEvent } from "#context/dynamic-model-lifecycle.js";
import { dispatchDynamicSkillEvent } from "#context/dynamic-skill-lifecycle.js";
import { dispatchDynamicSubagentEvent } from "#context/dynamic-subagent-lifecycle.js";
import { dispatchDynamicToolEvent } from "#context/dynamic-tool-lifecycle.js";
import { dispatchStreamEventHooks } from "#context/hook-lifecycle.js";
import { dispatchMemoryLifecycleEvent } from "#context/memory-event-lifecycle.js";
import { setChannelContext } from "#execution/channel-context.js";
import { bindDynamicConnections } from "#execution/dynamic-connections.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { observeSessionActivity } from "#execution/session-activity-projection.js";
import { forwardTaskEventToSessionCallback } from "#execution/task-event-callback.js";
import type { HarnessSession } from "#harness/types.js";
import {
  encodeMessageStreamEvent,
  stampMessageStreamEvent,
  type MessageStreamEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

/** One event path for live progress and committed terminal effects. */
export function bindTurnEvents(input: {
  readonly abortSignal?: AbortSignal;
  readonly ctx: ContextContainer;
  readonly events: WritableStream<Uint8Array>;
  readonly session: HarnessSession;
}) {
  const { ctx, session } = input;
  const adapter = ctx.require(ChannelKey);
  const adapterCtx = buildAdapterContext(adapter, ctx);
  const bundle = ctx.require(BundleKey);
  const effectiveAgent = resolveEffectiveAgentRuntime(bundle, ctx);
  const dynamicConnections = bindDynamicConnections(ctx, bundle.resolvedAgent);
  const writer = input.events.getWriter();

  return {
    release() {
      writer.releaseLock();
    },
    async handleEvent(
      event: UnstampedMessageStreamEvent | MessageStreamEvent,
      messages?: readonly import("ai").ModelMessage[],
    ): Promise<void> {
      const forwarded = await forwardTaskEventToSessionCallback(ctx, event);
      const transformed = forwarded
        ? event
        : await callAdapterEventHandler(adapter, event, adapterCtx);
      if (!forwarded) setChannelContext(ctx, { ...adapter, state: { ...adapterCtx.state } });
      const emitted =
        "meta" in event
          ? ({ ...transformed, meta: event.meta } as MessageStreamEvent)
          : stampMessageStreamEvent(transformed);
      if (!forwarded) await writer.write(encodeMessageStreamEvent(emitted));

      const lifecycleMessages = await dispatchMemoryLifecycleEvent({
        abortSignal: input.abortSignal,
        appRoot: bundle.graph.root.agent?.metadata?.appRoot ?? "",
        ctx,
        event,
        memories: bundle.graph.root.agent?.memories ?? [],
        messages,
        nodeId: bundle.nodeId ?? "__root__",
      });
      void observeSessionActivity({ ctx, event: emitted, sessionId: session.sessionId });
      await dispatchStreamEventHooks({ ctx, registry: bundle.hookRegistry, event: emitted });
      if (emitted.type !== "step.started") {
        await dispatchDynamicModelEvent({
          ctx,
          dynamicModel: effectiveAgent.turnAgent.dynamicModel,
          event: emitted,
          messages: lifecycleMessages,
          scope: { moduleMap: bundle.moduleMap, nodeId: bundle.nodeId },
        });
      }
      await dynamicConnections.dispatch(emitted);
      await dispatchDynamicSubagentEvent({
        ctx,
        resolvers: bundle.subagentRegistry.dynamicResolvers ?? [],
        event: emitted,
        messages: lifecycleMessages,
      });
      await dispatchDynamicToolEvent({
        ctx,
        resolvers: bundle.resolvedAgent.dynamicToolResolvers ?? [],
        event: emitted,
        messages: lifecycleMessages,
      });
      await dispatchDynamicSkillEvent({
        ctx,
        resolvers: bundle.resolvedAgent.dynamicSkillResolvers ?? [],
        event: emitted,
        messages: lifecycleMessages,
      });
      await dispatchDynamicInstructionEvent({
        ctx,
        resolvers: bundle.resolvedAgent.dynamicInstructionsResolvers ?? [],
        event: emitted,
        messages: lifecycleMessages,
      });
    },
  };
}

/** Applies non-model events with the same lifecycle and persisted context as model events. */
export async function emitTurnEvent(input: {
  readonly events: WritableStream<Uint8Array>;
  readonly event: UnstampedMessageStreamEvent;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<{
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}> {
  const ctx = await deserializeContext(input.serializedContext);
  const effective = resolveEffectiveAgentRuntime(ctx.require(BundleKey), ctx);
  const session = hydrateDurableSession({
    durable: input.sessionState.snapshot.session,
    turnAgent: effective.turnAgent,
    compactionOverrides: { thresholdPercent: effective.thresholdPercent },
  });
  const scoped = await withContextScope(ctx, session, async (enrichedSession) => {
    const sink = bindTurnEvents({ ctx, events: input.events, session: enrichedSession });
    try {
      ctx.setVirtualContext(HandleEventKey, sink.handleEvent);
      await sink.handleEvent(input.event, enrichedSession.history);
      return { result: undefined, session: enrichedSession };
    } finally {
      sink.release();
    }
  });
  return {
    serializedContext: serializeContext(ctx),
    sessionState: createDurableSessionState({
      session: reconcileSessionContinuationToken(ctx, scoped.session),
    }),
  };
}
