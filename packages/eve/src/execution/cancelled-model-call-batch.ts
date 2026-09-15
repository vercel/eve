import { contextStorage, type ContextContainer } from "#context/container.js";
import { TurnDeliveryIdsKey } from "#context/keys.js";
import { preserveSerializedSessionDynamicModelSelection } from "#context/serialized-dynamic-model-selection.js";
import { serializeContext } from "#context/serialize.js";
import { preserveCancelledTurnMessage } from "#execution/cancelled-turn-message.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import type { DurableStepResult } from "#execution/turn-step.js";
import { readRetainedBackgroundToolResult } from "#execution/tasks/parent/tool-execution.js";
import type { HarnessSession, StepInput, StepResult } from "#harness/types.js";
import { preserveSerializedInstrumentationState } from "#instrumentation/state.js";
import { preserveSerializedBackgroundTaskObservabilityState } from "#shared/serialized-observability-state.js";
import { preserveSerializedAgentTraceState } from "#tracing/agent-trace-context-store.js";

export interface CompletedModelCallCheckpoint {
  readonly result: StepResult;
  readonly serializedContext: Record<string, unknown>;
}

/** Builds the successful step result that commits a cancelled batch's completed model calls. */
export async function createCancelledModelCallBatchResult(input: {
  readonly beforeBatchContext: Record<string, unknown>;
  readonly checkpoint: CompletedModelCallCheckpoint | undefined;
  readonly ctx: ContextContainer;
  readonly initialSession: HarnessSession;
  readonly stepInput: StepInput | undefined;
}): Promise<DurableStepResult> {
  const interruptedContext = serializeContext(input.ctx);
  const retained = readRetainedBackgroundToolResult(input.ctx);
  const backgroundTaskSession =
    retained?.backgroundTaskSession ?? input.checkpoint?.result.backgroundTaskSession;
  const backgroundTasks = retained?.backgroundTasks ?? input.checkpoint?.result.backgroundTasks;
  const checkpointSession =
    backgroundTaskSession ?? input.checkpoint?.result.session ?? input.initialSession;
  const cancelledSession =
    input.checkpoint === undefined
      ? await contextStorage.run(input.ctx, () =>
          preserveCancelledTurnMessage(checkpointSession, input.stepInput),
        )
      : checkpointSession;
  const checkpointContext = {
    ...(input.checkpoint?.serializedContext ?? input.beforeBatchContext),
    [TurnDeliveryIdsKey.name]: interruptedContext[TurnDeliveryIdsKey.name],
  };

  return {
    action: "cancelled",
    ...(backgroundTaskSession === undefined || backgroundTasks === undefined
      ? {}
      : {
          backgroundTaskContext: preserveSerializedBackgroundTaskObservabilityState(
            input.beforeBatchContext,
            interruptedContext,
            backgroundTasks,
          ),
          backgroundTaskState: createDurableSessionState({ session: cancelledSession }),
          backgroundTasks,
        }),
    serializedContext: preserveSerializedInstrumentationState(
      preserveSerializedAgentTraceState(
        preserveSerializedSessionDynamicModelSelection(checkpointContext, interruptedContext),
        interruptedContext,
      ),
      interruptedContext,
    ),
    sessionState: createDurableSessionState({ session: cancelledSession }),
  };
}
