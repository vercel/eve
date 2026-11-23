import { contextStorage, type ContextContainer } from "#context/container.js";
import { createLogger } from "#internal/logging.js";
import {
  AuthKey,
  ChannelInstrumentationKey,
  SandboxKey,
  SteeredByKey,
  TurnDeliveryIdsKey,
} from "#context/keys.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { DefinitionsStateKey } from "#definitions/state.js";
import { withContextScope } from "#context/run-step.js";
import { serializeContext } from "#context/serialize.js";
import { preserveCancelledTurnMessage } from "#execution/cancelled-turn-message.js";
import { createDurableSessionValues } from "#execution/durable-session-store.js";
import type { DurableStepResult } from "#execution/session/turn-step-types.js";
import type { HarnessSession, HarnessStepInput, StepResult } from "#harness/types.js";
import { appliedSession, saveSessionProjection } from "#harness/session-machine/current.js";
import { takeDeferredMessage } from "#harness/hitl/index.js";
import { preserveSerializedInstrumentationState } from "#instrumentation/state.js";
import { preserveSerializedAgentTraceState } from "#tracing/eve/agent-trace-context-store.js";
import { markSandboxRunning } from "#sandbox/state.js";

const log = createLogger("execution.cancelled-turn");

export interface CompletedModelCallCheckpoint {
  readonly result: StepResult;
  readonly serializedContext: Record<string, unknown>;
}

async function cancelledWithoutCheckpoint(
  ctx: ContextContainer,
  initial: HarnessSession,
  stepInput: HarnessStepInput | undefined,
): Promise<HarnessSession> {
  const applied = appliedSession<HarnessSession>(ctx);
  let session = applied ?? initial;
  let preserved = stepInput;
  if (applied !== undefined) {
    const deferred = takeDeferredMessage(applied);
    session = deferred.session;
    if (deferred.message !== undefined) preserved = { ...stepInput, message: deferred.message };
  }
  return await preserveStoppedTurnMessage(ctx, session, preserved);
}

export async function preserveStoppedTurnMessage(
  ctx: ContextContainer,
  session: HarnessSession,
  preserved: HarnessStepInput | undefined,
): Promise<HarnessSession> {
  if (ctx.get(SandboxKey) === undefined && hasFileParts(preserved?.message)) {
    try {
      const scoped = await withContextScope(ctx, session, async (current) => ({
        result: undefined,
        session: await preserveCancelledTurnMessage(current, preserved),
      }));
      return scoped.session;
    } catch (error) {
      log.warn("staging a cancelled turn's attachments failed", { error });
      ctx.clearVirtualContext();
    }
  }
  return await contextStorage.run(ctx, () => preserveCancelledTurnMessage(session, preserved));
}

function hasFileParts(message: HarnessStepInput["message"]): boolean {
  return Array.isArray(message) && message.some((part) => part.type === "file");
}

export async function createCancelledModelCallBatchResult(input: {
  readonly beforeBatchContext: Record<string, unknown>;
  readonly checkpoint: CompletedModelCallCheckpoint | undefined;
  readonly ctx: ContextContainer;
  readonly initialSession: HarnessSession;
  readonly sandboxIdleTimeoutMs: number | undefined;
  readonly stepInput: HarnessStepInput | undefined;
}): Promise<DurableStepResult> {
  const interruptedContext = serializeContext(input.ctx);
  const cancelledSession =
    input.checkpoint?.result.session ??
    (await cancelledWithoutCheckpoint(input.ctx, input.initialSession, input.stepInput));
  const checkpointContext: Record<string, unknown> = {
    ...(input.checkpoint?.serializedContext ?? input.beforeBatchContext),
    [AuthKey.name]: interruptedContext[AuthKey.name],
    [TurnDeliveryIdsKey.name]: interruptedContext[TurnDeliveryIdsKey.name],
    [DefinitionsStateKey.name]: interruptedContext[DefinitionsStateKey.name],
    [ChannelKey.name]: interruptedContext[ChannelKey.name],
    ...(ChannelInstrumentationKey.name in interruptedContext && {
      [ChannelInstrumentationKey.name]: interruptedContext[ChannelInstrumentationKey.name],
    }),
  };
  if (SteeredByKey.name in interruptedContext) {
    checkpointContext[SteeredByKey.name] = interruptedContext[SteeredByKey.name];
  } else {
    delete checkpointContext[SteeredByKey.name];
  }

  return {
    action: "cancelled",
    serializedContext: preserveSerializedInstrumentationState(
      preserveSerializedAgentTraceState(checkpointContext, interruptedContext),
      interruptedContext,
    ),
    ...createDurableSessionValues(
      saveSessionProjection(
        markSandboxRunning(cancelledSession, input.sandboxIdleTimeoutMs),
        input.ctx,
      ),
    ),
  };
}
