import type { SessionEvent } from "#protocol/session-event.js";
import type { ModelMessage } from "ai";

import { contextStorage, type ContextContainer } from "#context/container.js";
import { resolveDynamicConnections } from "#context/dynamic-connection-lifecycle.js";
import { resolveDynamicInstructions } from "#context/dynamic-instruction-lifecycle.js";
import { resolveDynamicModel } from "#context/dynamic-model-lifecycle.js";
import {
  resolveDynamicSkills,
} from "#context/dynamic-skill-lifecycle.js";
import {
  refreshDynamicSessionSubagentsForRuntimeRevision,
  resolveDynamicSubagents,
} from "#context/dynamic-subagent-lifecycle.js";
import {
  preparePersistedStepDynamicToolMetadata,
  rebindMissingCompiledDynamicToolCallbacks,
  refreshDynamicSessionToolsForRuntimeRevision,
  resolveDynamicTools,
} from "#context/dynamic-tool-lifecycle.js";
import {
  SessionDynamicSubagentRuntimeRevisionKey,
  SessionDynamicToolRuntimeRevisionKey,
  SessionIdKey,
} from "#context/keys.js";
import {
  dispatchMemoryCompactionCompleted,
  dispatchMemoryCompactionRequested,
  dispatchMemoryTurnCompleted,
  dispatchMemoryTurnStarted,
} from "#context/memory-lifecycle.js";
import type { DynamicScopeEvent, DynamicSessionOrTurnEvent } from "#dynamic/definition.js";
import type { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import {
  compactionCompletedPoint,
  compactionRequestedPoint,
  sessionStartedForResolvers,
  stepStartedForResolvers,
  turnCompletedPoint,
  turnStartedForResolvers,
} from "#harness/session-machine/change-points.js";
import { currentProjection } from "#harness/session-machine/current.js";
import { turnCoordinates } from "#protocol/session-projection.js";
import type { StepParticipants } from "#harness/types.js";
import type { ExecutionInstrumentation } from "#instrumentation/runtime.js";
import { createLogger } from "#internal/logging.js";
import type { RuntimeIdentity } from "#protocol/message.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import { clearDurableDynamicCallbacks } from "#tools/durable-callbacks.js";

const log = createLogger("memory");

type TurnRef = { readonly sequence: number; readonly turnId: string };

/**
 * The session's participants: memory, then the dynamic model, connections, subagents, tools,
 * skills, and instructions, always in that order. They run after an event's hooks, for the events
 * they receive, and at the moments a step reaches without publishing one.
 */
export interface SessionParticipants extends StepParticipants {
  /** Runs the participants that receive a published event. Progress reaches none of them. */
  receive(event: SessionEvent, messages?: readonly ModelMessage[]): Promise<void>;
  /**
   * Rebuilds what recorded results need in this process: after a redeploy, the session's tools
   * and subagents resolve again, and a running turn's tools rebind their callbacks.
   */
  restore(input: {
    readonly runtime: RuntimeIdentity;
    readonly runtimeRevision: string;
    readonly sessionStarted: boolean;
    readonly turn: TurnRef | undefined;
    readonly messages: readonly ModelMessage[];
  }): Promise<void>;
  /** Connections aren't recorded, so they resolve again before each model call. */
  rehydrateConnections(input: {
    readonly runtime: RuntimeIdentity;
    readonly turn: TurnRef | undefined;
  }): Promise<void>;
}

/** Binds the bundle's participants to one turn step. */
export function bindSessionParticipants(input: {
  readonly abortSignal: AbortSignal;
  readonly bundle: CompiledBundle;
  readonly ctx: ContextContainer;
  readonly effectiveAgent: ReturnType<typeof resolveEffectiveAgentRuntime>;
  readonly effectiveNode: CompiledBundle["graph"]["root"];
  readonly instrumentation: ExecutionInstrumentation | undefined;
}): SessionParticipants {
  const { abortSignal, bundle, ctx, effectiveNode } = input;
  const agent = bundle.resolvedAgent;
  const memories = effectiveNode.agent?.memories ?? [];
  const memory = {
    abortSignal,
    ctx,
    instrumentation: input.instrumentation?.memory,
    memories,
  };
  const connections = agent.dynamicConnectionResolvers ?? [];
  const tools = agent.dynamicToolResolvers ?? [];
  const subagents = bundle.subagentRegistry.dynamicResolvers ?? [];

  const resolveModel = (event: DynamicScopeEvent, messages: readonly ModelMessage[]) =>
    resolveDynamicModel({
      abortSignal,
      ctx,
      dynamicModel: input.effectiveAgent.turnAgent.dynamicModel,
      event,
      messages,
      scope: { moduleMap: bundle.moduleMap, nodeId: bundle.nodeId },
    });

  /** A session's or a turn's start: every resolver that answers that scope, in order. */
  const resolveScope = async (
    event: DynamicSessionOrTurnEvent,
    messages: readonly ModelMessage[],
  ): Promise<void> => {
    await resolveModel(event, messages);
    await resolveDynamicConnections({ ctx, event, resolvers: connections });
    await resolveDynamicSubagents({ ctx, event, messages, resolvers: subagents });
    await resolveDynamicTools({ ctx, event, messages, resolvers: tools });
    await resolveDynamicSkills({
      ctx,
      event,
      messages,
      resolvers: agent.dynamicSkillResolvers ?? [],
    });
    await resolveDynamicInstructions({
      ctx,
      event,
      messages,
      resolvers: agent.dynamicInstructionsResolvers ?? [],
    });
  };

  /** Where the session stands for a change point's payload: its turn, and a run's step. */
  const coordinates = (runId?: string) => {
    const projection = currentProjection(ctx);
    const turn = turnCoordinates(projection);
    const run = runId === undefined ? undefined : projection.runs?.[runId];
    return { ...turn, stepIndex: run?.stepIndex ?? turn.stepIndex };
  };
  const previewModelId = () => input.effectiveAgent.turnAgent.model?.id ?? "dynamic";

  return {
    async receive(event, messages) {
      switch (event.type) {
        case "session.started":
          await resolveScope(sessionStartedForResolvers(event.data.runtime), messages ?? []);
          return;
        case "turn.started": {
          const turn = turnStartedForResolvers(coordinates());
          // Recall runs first, so the resolvers see what it brought back.
          const recalled =
            memories.length === 0
              ? (messages ?? [])
              : await dispatchMemoryTurnStarted({
                  ...memory,
                  appRoot: effectiveNode.agent?.metadata?.appRoot ?? "",
                  event: turn,
                  nodeId: bundle.nodeId ?? "__root__",
                });
          await resolveScope(turn, recalled);
          return;
        }
        case "model.requested": {
          const { owner, runId } = event.data;
          const at = coordinates(runId);
          const step = stepStartedForResolvers({ ...at, modelId: previewModelId() });
          await resolveModel(step, messages ?? []);
          // A compaction's summary run is the model's alone.
          if ("changeId" in owner) return;
          await resolveDynamicTools({
            ctx,
            event: step,
            messages: messages ?? [],
            resolvers: tools,
          });
          return;
        }
        case "context.started":
          if (event.data.kind !== "compaction" || memories.length === 0) return;
          await dispatchMemoryCompactionRequested({
            ...memory,
            appRoot: effectiveNode.agent?.metadata?.appRoot ?? "",
            event: compactionRequestedPoint({
              ...coordinates(),
              modelId: previewModelId(),
              sessionId: ctx.get(SessionIdKey) ?? "",
              turnId: event.data.turnId ?? "",
              usageInputTokens: event.data.trigger?.inputTokens ?? null,
            }),
            messages: messages ?? [],
            nodeId: bundle.nodeId ?? "__root__",
          });
          return;
        case "context.settled":
          if (event.data.kind !== "compaction" || event.data.outcome !== "completed") return;
          if (memories.length === 0) return;
          await dispatchMemoryCompactionCompleted({
            ...memory,
            event: compactionCompletedPoint({
              ...coordinates(),
              modelId: previewModelId(),
              sessionId: ctx.get(SessionIdKey) ?? "",
              turnId: currentProjection(ctx).activeTurnId ?? "",
            }),
            messages: messages ?? [],
          });
          return;
        case "turn.settled":
          if (event.data.outcome !== "completed") return;
          if (memories.length === 0 || messages === undefined) return;
          try {
            await dispatchMemoryTurnCompleted({
              ...memory,
              event: turnCompletedPoint({
                sequence: currentProjection(ctx).turns[event.data.turnId]?.sequence ?? 0,
                turnId: event.data.turnId,
              }),
              messages,
            });
          } catch (error) {
            log.error("Completed-turn memory capture failed.", { error });
          }
          return;
        case "session.ended": {
          if (event.data.outcome !== "completed") return;
          const sessionId = ctx.get(SessionIdKey);
          if (sessionId !== undefined) clearDurableDynamicCallbacks(sessionId);
          return;
        }
        default:
          return;
      }
    },

    async selectModel({ at, messages, modelId }) {
      await resolveModel(stepStartedForResolvers({ ...at, modelId }), messages);
    },

    async restoreStep({ at, messages, modelId, parked }) {
      if (parked) {
        await resolveDynamicConnections({
          ctx,
          event: turnStartedForResolvers(at),
          resolvers: connections,
        });
      }
      await preparePersistedStepDynamicToolMetadata({
        ctx,
        event: stepStartedForResolvers({ ...at, modelId }),
        messages,
        resolvers: tools,
      });
    },

    async restore({ messages, runtime, runtimeRevision, sessionStarted, turn }) {
      if (!sessionStarted) {
        ctx.set(SessionDynamicSubagentRuntimeRevisionKey, runtimeRevision);
        ctx.set(SessionDynamicToolRuntimeRevisionKey, runtimeRevision);
        return;
      }
      const event = sessionStartedForResolvers(runtime);
      await Promise.all([
        refreshDynamicSessionSubagentsForRuntimeRevision({
          ctx,
          event,
          messages,
          resolvers: subagents,
          runtimeRevision,
        }),
        contextStorage.run(ctx, () =>
          refreshDynamicSessionToolsForRuntimeRevision({
            ctx,
            event,
            messages,
            resolvers: tools,
            runtimeRevision,
          }),
        ),
      ]);
      if (turn === undefined) return;
      await rebindMissingCompiledDynamicToolCallbacks({
        ctx,
        event: turnStartedForResolvers(turn),
        messages,
        resolvers: tools,
      });
    },

    async rehydrateConnections({ runtime, turn }) {
      await resolveDynamicConnections({
        ctx,
        event: sessionStartedForResolvers(runtime),
        resolvers: connections,
      });
      if (turn === undefined) return;
      await resolveDynamicConnections({
        ctx,
        event: turnStartedForResolvers(turn),
        resolvers: connections,
      });
    },
  };
}
