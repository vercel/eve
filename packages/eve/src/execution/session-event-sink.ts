import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler, type ChannelAdapter } from "#channel/adapter.js";
import type { ContextContainer } from "#context/container.js";
import { dispatchDynamicInstructionEvent } from "#context/dynamic-instruction-lifecycle.js";
import { dispatchDynamicModelEvent } from "#context/dynamic-model-lifecycle.js";
import { dispatchDynamicSkillEvent } from "#context/dynamic-skill-lifecycle.js";
import { dispatchDynamicSubagentEvent } from "#context/dynamic-subagent-lifecycle.js";
import { dispatchDynamicToolEvent } from "#context/dynamic-tool-lifecycle.js";
import { dispatchStreamEventHooks } from "#context/hook-lifecycle.js";
import { TurnDeliveryIdsKey } from "#context/keys.js";
import { dispatchMemoryLifecycleEvent } from "#context/memory-event-lifecycle.js";
import * as activityCohort from "#execution/activity-cohort.js";
import { setChannelContext } from "#execution/channel-context.js";
import { bindDynamicConnections } from "#execution/dynamic-connections.js";
import type { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { observeSessionActivity } from "#execution/session-activity-projection.js";
import { forwardTaskEventToSessionCallback } from "#execution/task-event-callback.js";
import type { HandleEventFn } from "#harness/types.js";
import type { ExecutionInstrumentation } from "#instrumentation/runtime.js";
import {
  encodeMessageStreamEvent,
  type MessageStreamEvent,
  stampMessageStreamEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";

export interface SessionEventSinkInput {
  readonly abortSignal: AbortSignal | undefined;
  readonly adapter: ChannelAdapter;
  readonly bundle: CompiledBundle;
  readonly ctx: ContextContainer;
  readonly effectiveAgent: ReturnType<typeof resolveEffectiveAgentRuntime>;
  readonly instrumentation: ExecutionInstrumentation | undefined;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly sessionId: string;
}

export interface SessionEventSink {
  readonly adapterCtx: ReturnType<typeof buildAdapterContext>;
  readonly dynamicConnections: ReturnType<typeof bindDynamicConnections>;
  readonly effectiveNode: CompiledBundle["graph"]["root"];
  readonly handleEvent: HandleEventFn;
  /** Closes the parent stream; only a terminal `done` step does this. */
  close(): Promise<void>;
  /** Releases the writer lock so the next step can acquire it. */
  release(): void;
}

/** Binds adapter context, dynamic connections, and event fan-out to one step's stream writer. */
export function createSessionEventSink(input: SessionEventSinkInput): SessionEventSink {
  const { adapter, bundle, ctx, effectiveAgent, instrumentation } = input;
  const adapterCtx = buildAdapterContext(adapter, ctx);
  const dynamicConnections = bindDynamicConnections(ctx, bundle.resolvedAgent);
  const effectiveNode = { ...bundle.graph.root, turnAgent: effectiveAgent.turnAgent };
  const writer = input.parentWritable.getWriter();

  const emit = async (event: UnstampedMessageStreamEvent): Promise<MessageStreamEvent> => {
    const toEmit = await callAdapterEventHandler(adapter, event, adapterCtx);
    setChannelContext(ctx, { ...adapter, state: { ...adapterCtx.state } });
    const stamped = stampMessageStreamEvent(toEmit, ctx.get(TurnDeliveryIdsKey));
    await writer.write(encodeMessageStreamEvent(stamped));
    return stamped;
  };
  const handleEvent: HandleEventFn = async (event, messages): Promise<void> => {
    activityCohort.updateActivityBlockers(ctx, event);
    const forwardedToTaskParent = await forwardTaskEventToSessionCallback(ctx, event);
    const emitted = forwardedToTaskParent
      ? stampMessageStreamEvent(event, ctx.get(TurnDeliveryIdsKey))
      : await emit(event);
    const lifecycleMessages = await dispatchMemoryLifecycleEvent({
      abortSignal: input.abortSignal,
      appRoot: effectiveNode.agent?.metadata?.appRoot ?? "",
      ctx,
      event,
      instrumentation: instrumentation?.memory,
      memories: effectiveNode.agent?.memories ?? [],
      messages,
      nodeId: bundle.nodeId ?? "__root__",
    });
    void observeSessionActivity({ ctx, event: emitted, sessionId: input.sessionId });
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
  };

  return {
    adapterCtx,
    close: () => writer.close(),
    dynamicConnections,
    effectiveNode,
    handleEvent,
    release: () => writer.releaseLock(),
  };
}
