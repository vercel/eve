import { dispatchDynamicInstructionEvent } from "#context/dynamic-instruction-lifecycle.js";
import { dispatchDynamicModelEvent } from "#context/dynamic-model-lifecycle.js";
import { dispatchDynamicSkillEvent } from "#context/dynamic-skill-lifecycle.js";
import { dispatchDynamicSubagentEvent } from "#context/dynamic-subagent-lifecycle.js";
import { dispatchDynamicToolEvent } from "#context/dynamic-tool-lifecycle.js";
import type { ContextContainer } from "#context/container.js";
import { dispatchStreamEventHooks } from "#context/hook-lifecycle.js";
import { dispatchMemoryLifecycleEvent } from "#context/memory-event-lifecycle.js";
import type { bindDynamicConnections } from "#execution/dynamic-connections.js";
import type { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import type { SessionEventSink } from "#execution/session/event-sink.js";
import { throwIfTurnAborted, TurnCancelledError } from "#harness/turn-cancellation.js";
import type { HandleEventFn } from "#harness/types.js";
import type { ExecutionInstrumentation } from "#instrumentation/runtime.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";

/** Events at or after turn settlement; cancelling from them would add a second terminal. */
const TURN_SETTLEMENT_EVENT_TYPES: ReadonlySet<string> = new Set([
  "session.completed",
  "session.failed",
  "session.waiting",
  "turn.cancelled",
  "turn.completed",
  "turn.failed",
]);

/**
 * Publishes one turn event, then runs memory, hooks, and model preparation for it.
 * A hook `ctx.cancel()` takes effect after every consumer has seen the event.
 */
export function createTurnEventHandler(input: {
  readonly abortSignal: AbortSignal;
  readonly bundle: CompiledBundle;
  /** False for clear and compact requests, which run outside any turn. */
  readonly canCancelTurn: boolean;
  readonly hookCancellation: AbortController;
  readonly ctx: ContextContainer;
  readonly dynamicConnections: ReturnType<typeof bindDynamicConnections>;
  readonly effectiveAgent: ReturnType<typeof resolveEffectiveAgentRuntime>;
  readonly effectiveNode: CompiledBundle["graph"]["root"];
  readonly instrumentation: ExecutionInstrumentation | undefined;
  readonly sink: SessionEventSink;
}): HandleEventFn {
  const { abortSignal, bundle, ctx, effectiveAgent, effectiveNode } = input;
  return async (event, messages) => {
    const emitted = await input.sink.emit(event);
    const lifecycleMessages = await dispatchMemoryLifecycleEvent({
      abortSignal,
      appRoot: effectiveNode.agent?.metadata?.appRoot ?? "",
      ctx,
      event,
      instrumentation: input.instrumentation?.memory,
      memories: effectiveNode.agent?.memories ?? [],
      messages,
      nodeId: bundle.nodeId ?? "__root__",
    });
    let cancelRequested = false;
    if (!emitted.suppressed) {
      await dispatchStreamEventHooks({
        cancelTurn:
          input.canCancelTurn && !TURN_SETTLEMENT_EVENT_TYPES.has(emitted.event.type)
            ? () => {
                cancelRequested = true;
              }
            : undefined,
        ctx,
        registry: bundle.hookRegistry,
        event: emitted.event,
      });
    }
    if (emitted.event.type !== "step.started") {
      await dispatchDynamicModelEvent({
        abortSignal,
        ctx,
        dynamicModel: effectiveAgent.turnAgent.dynamicModel,
        event: emitted.event,
        messages: lifecycleMessages,
        scope: { moduleMap: bundle.moduleMap, nodeId: bundle.nodeId },
      });
    }
    await input.dynamicConnections.dispatch(emitted.event);
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
    if (cancelRequested) {
      input.hookCancellation.abort(new TurnCancelledError());
      throwIfTurnAborted(input.hookCancellation.signal);
    }
  };
}
