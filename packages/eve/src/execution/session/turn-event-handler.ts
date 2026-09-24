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
import type { HookEventType } from "#public/definitions/hook.js";
import type { ExecutionInstrumentation } from "#instrumentation/runtime.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";

/**
 * Whether `ctx.cancel()` from a hook on each event may stop the running turn.
 * Total over hook events, so a new event must be classified before it compiles.
 * Settlement events stay false: cancelling there would give the turn a second terminal.
 */
const HOOK_CANCELLABLE_EVENTS = {
  "action.input.appended": true,
  "action.partial": true,
  "action.result": true,
  "actions.requested": true,
  "approval.candidate": true,
  "approval.settled": true,
  "authorization.completed": true,
  "authorization.required": true,
  "compaction.completed": true,
  "compaction.requested": true,
  "context.cleared": false,
  "input.requested": true,
  "input.resolved": true,
  "message.appended": true,
  "message.completed": true,
  "message.received": true,
  "reasoning.appended": true,
  "reasoning.completed": true,
  "result.completed": true,
  "session.completed": false,
  "session.failed": false,
  "session.started": true,
  "session.waiting": false,
  "step.completed": true,
  "step.failed": false,
  "step.started": true,
  "subagent.called": false,
  "subagent.completed": false,
  "subagent.event": false,
  "subagent.started": false,
  "turn.cancelled": false,
  "turn.completed": false,
  "turn.failed": false,
  "turn.started": true,
} as const satisfies Record<HookEventType, boolean>;

/** True when a hook on this event type may cancel the running turn. */
export function isHookCancellableEvent(type: string): boolean {
  return (HOOK_CANCELLABLE_EVENTS as Readonly<Record<string, boolean>>)[type] === true;
}

/**
 * Publishes one turn event, then runs memory, hooks, and model preparation for it.
 * A hook's `ctx.cancel()` aborts the turn signal at once; the event's remaining
 * hooks still run, then the handler stops the turn before the next model call.
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
    const cancelTurn =
      input.canCancelTurn && isHookCancellableEvent(emitted.event.type)
        ? () => input.hookCancellation.abort(new TurnCancelledError())
        : undefined;
    if (!emitted.suppressed) {
      await dispatchStreamEventHooks({
        cancelTurn,
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
    if (cancelTurn !== undefined) throwIfTurnAborted(input.hookCancellation.signal);
  };
}
