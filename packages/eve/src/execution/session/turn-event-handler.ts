import type { ContextContainer } from "#context/container.js";
import { dispatchDynamicInstructionEvent } from "#context/dynamic-instruction-lifecycle.js";
import { dispatchDynamicModelEvent } from "#context/dynamic-model-lifecycle.js";
import { dispatchDynamicSkillEvent } from "#context/dynamic-skill-lifecycle.js";
import { dispatchDynamicSubagentEvent } from "#context/dynamic-subagent-lifecycle.js";
import { dispatchDynamicToolEvent } from "#context/dynamic-tool-lifecycle.js";
import { dispatchStreamEventHooks } from "#context/hook-lifecycle.js";
import { dispatchMemoryLifecycleEvent } from "#context/memory-event-lifecycle.js";
import { bindDynamicConnections } from "#execution/dynamic-connections.js";
import type { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import type { SessionEventSink } from "#execution/session/event-sink.js";
import type { HandleEventFn } from "#harness/types.js";
import type { ExecutionInstrumentation } from "#instrumentation/runtime.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";

export function createTurnEventHandler(input: {
  readonly abortSignal: AbortSignal | undefined;
  readonly bundle: CompiledBundle;
  readonly ctx: ContextContainer;
  readonly effectiveAgent: ReturnType<typeof resolveEffectiveAgentRuntime>;
  readonly instrumentation: ExecutionInstrumentation | undefined;
  readonly sink: SessionEventSink;
}) {
  const { bundle, ctx, effectiveAgent, instrumentation, sink } = input;
  const dynamicConnections = bindDynamicConnections(ctx, bundle.resolvedAgent);
  const effectiveNode = { ...bundle.graph.root, turnAgent: effectiveAgent.turnAgent };
  const handleEvent: HandleEventFn = async (event, messages): Promise<void> => {
    const emitted = await sink.emit(event);
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
    if (!emitted.suppressed) {
      await dispatchStreamEventHooks({ ctx, registry: bundle.hookRegistry, event: emitted.event });
    }
    if (emitted.event.type !== "step.started") {
      await dispatchDynamicModelEvent({
        abortSignal: input.abortSignal,
        ctx,
        dynamicModel: effectiveAgent.turnAgent.dynamicModel,
        event: emitted.event,
        messages: lifecycleMessages,
        scope: { moduleMap: bundle.moduleMap, nodeId: bundle.nodeId },
      });
    }
    await dynamicConnections.dispatch(emitted.event);
    await dispatchDynamicSubagentEvent({
      ctx,
      resolvers: bundle.subagentRegistry.dynamicResolvers ?? [],
      event: emitted.event,
      messages: lifecycleMessages,
    });
    await dispatchDynamicToolEvent({
      ctx,
      resolvers: bundle.resolvedAgent.dynamicToolResolvers ?? [],
      event: emitted.event,
      messages: lifecycleMessages,
    });
    await dispatchDynamicSkillEvent({
      ctx,
      resolvers: bundle.resolvedAgent.dynamicSkillResolvers ?? [],
      event: emitted.event,
      messages: lifecycleMessages,
    });
    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: bundle.resolvedAgent.dynamicInstructionsResolvers ?? [],
      event: emitted.event,
      messages: lifecycleMessages,
    });
  };

  return { dynamicConnections, effectiveNode, handleEvent };
}
