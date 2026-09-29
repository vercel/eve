import { contextStorage, type ContextContainer } from "#context/container.js";
import { TurnDeliveryIdsKey } from "#context/keys.js";
import { preserveSerializedSessionDynamicModelSelection } from "#context/serialized-dynamic-model-selection.js";
import { serializeContext } from "#context/serialize.js";
import { preserveCancelledTurnMessage } from "#execution/cancelled-turn-message.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import type { DurableStepResult } from "#execution/session/turn-step-types.js";
import type { HarnessSession, StepInput, StepResult } from "#harness/types.js";
import { preserveSerializedInstrumentationState } from "#instrumentation/state.js";
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
  const checkpointSession = input.checkpoint?.result.session ?? input.initialSession;
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
