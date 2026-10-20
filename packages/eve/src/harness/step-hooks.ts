import type {
  GenerateTextOnStepStartCallback,
  LanguageModelUsage,
  ModelMessage,
  PrepareStepFunction,
  ProviderMetadata,
  StepResult,
  ToolSet,
  ToolResultPart,
} from "ai";
import {
  createActionResultEvent,
  createStepCompletedEvent,
  type StepCompletedProviderMetadata,
} from "#protocol/message.js";
import { createRuntimeToolResultFromMessagePart } from "#harness/action-result-helpers.js";
import type { ToolSignIn } from "#harness/call-executor.js";
import type { TurnPosition } from "#harness/session-machine/view.js";
import { normalizeAssistantStepFinishReason } from "#harness/finish-reason.js";
import type { ModelProfile } from "#harness/model-profile.js";
import { applyConversationCacheControl, mergeGatewayAutoCaching } from "#harness/prompt-cache.js";
import { resolveCallProviderOptions } from "#harness/provider-safety.js";
import {
  type HarnessEmitFn,
  type HarnessSession,
  requireSessionModelReference,
} from "#harness/types.js";
import { contextStorage } from "#context/container.js";
import { AuthKey } from "#context/keys.js";
import type { InputRequest } from "#shared/input.js";

// ---------------------------------------------------------------------------
// Step result type
// ---------------------------------------------------------------------------

/**
 * The subset of `StepResult` that the harness reads after a step completes, captured by the
 * `onStepEnd` callback.
 */
export type HarnessStepResult = Pick<
  StepResult<ToolSet>,
  | "content"
  | "finishReason"
  | "providerMetadata"
  | "response"
  | "text"
  | "toolCalls"
  | "toolResults"
  | "usage"
> & {
  /** The AI SDK's ID for the model call, which the telemetry of the calls it made shares. */
  readonly callId?: string;
  readonly invalidInputToolCallIds?: ReadonlySet<string>;
  /** The calls eve ran that wait on a person's approval. */
  readonly approvalRequests?: readonly InputRequest[];
  /** The calls eve ran that stopped for a sign-in. */
  readonly signIns?: readonly ToolSignIn[];
};

// ---------------------------------------------------------------------------
// Hook builder input / output
// ---------------------------------------------------------------------------

/**
 * Input for {@link buildStepHooks}.
 */
interface StepHooksInput {
  readonly auth?: import("#channel/types.js").SessionAuthContext | null;
  readonly profile: ModelProfile;
  /**
   * Starts the model step the SDK is about to run. Omitted when the step already started, as
   * it has for a retry of the same step.
   */
  readonly startStep?: (messages: readonly ModelMessage[]) => Promise<void>;
  readonly session: HarnessSession;
}

/**
 * Composable hooks returned by {@link buildStepHooks}.
 */
interface StepHooks {
  /**
   * `ToolLoopAgent` `onStepStart` callback.
   *
   * Starts the step from the prepared step input.
   */
  readonly onStepStart: GenerateTextOnStepStartCallback<ToolSet>;

  /**
   * `ToolLoopAgent` `onStepEnd` callback.
   *
   * Emits `actions.requested`, `action.result`, and `step.completed` events
   * from the captured step result.
   */
  readonly onStepEnd: (step: StepResult<ToolSet>) => Promise<void>;

  /**
   * `ToolLoopAgent` `prepareStep` callback.
   *
   * Handles cache/provider metadata. Compaction happens in the tool-loop
   * before `agent.stream()`.
   */
  readonly prepareStep: PrepareStepFunction<ToolSet>;

  /**
   * Promise that resolves when `onStepEnd` has completed.
   *
   * Await this after consuming the stream to ensure all step events
   * have been emitted before proceeding to post-step handling.
   *
   * Resolves once per hooks instance: a retried model call must rebuild
   * hooks via a fresh `ModelCaller.call` attempt. Re-running a call against
   * hooks whose `stepResult` already resolved reads the previous attempt's
   * result, not the retry's.
   *
   * Never settles when the step does not finish — e.g. the AI SDK's
   * incomplete-stream rejection (`NoOutputGeneratedError`) skips
   * `onStepEnd` entirely. Consumers must surface stream errors as
   * throws before awaiting this promise (`emitStreamContent` does), or
   * the await hangs.
   */
  readonly stepResult: Promise<HarnessStepResult>;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Builds composable `onStepStart`, `prepareStep`, and `onStepEnd` closures that
 * own all step-internal work: emission, compaction, and prompt caching.
 *
 * The harness passes these hooks to `ToolLoopAgent` and reads the
 * results via `stepResult` after the agent finishes.
 */
export function buildStepHooks(input: StepHooksInput): StepHooks {
  const session = input.session;

  let resolveStep: (step: HarnessStepResult) => void;
  const stepResult = new Promise<HarnessStepResult>((resolve) => {
    resolveStep = resolve;
  });

  // -------------------------------------------------------------------------
  // prepareStep
  //
  // Only handles cache/provider metadata. Compaction runs in the tool-loop
  // before `agent.stream()` so the compacted messages
  // flow through the same `messages` variable the harness uses to rebuild
  // session history — no prepareStep snapshot required.
  // -------------------------------------------------------------------------

  const prepareStep: PrepareStepFunction<ToolSet> = async ({ messages }) => {
    const { profile } = input;
    const stepResult: NonNullable<Awaited<ReturnType<PrepareStepFunction<ToolSet>>>> = {
      messages: profile.anthropicCache
        ? applyConversationCacheControl(messages, profile.anthropicCache)
        : messages,
    };

    const modelReference = requireSessionModelReference(session);
    const providerOptions = resolveCallProviderOptions({
      auth: input.auth ?? contextStorage.getStore()?.get(AuthKey) ?? null,
      profile,
      providerOptions: modelReference.providerOptions,
      session,
    });
    if (profile.gateway) {
      stepResult.providerOptions = mergeGatewayAutoCaching(providerOptions) as NonNullable<
        typeof stepResult.providerOptions
      >;
    } else if (providerOptions !== undefined) {
      stepResult.providerOptions = providerOptions as NonNullable<
        typeof stepResult.providerOptions
      >;
    }

    return stepResult;
  };

  const onStepStart: GenerateTextOnStepStartCallback<ToolSet> = async ({ messages }) => {
    await input.startStep?.(messages);
  };

  return {
    onStepEnd: async (step: StepResult<ToolSet>): Promise<void> => {
      resolveStep(step);
    },
    onStepStart,
    prepareStep,
    stepResult,
  };
}

// ---------------------------------------------------------------------------
// Step end
// ---------------------------------------------------------------------------

/**
 * Ends a step's events: the calls that didn't run report why, then `step.completed`. The stream
 * published the calls, and eve published the results of the calls it ran as they settled.
 */
export async function emitStepActions(
  emitFn: HarnessEmitFn,
  state: TurnPosition,
  step: HarnessStepResult,
  notRun: readonly ToolResultPart[],
): Promise<void> {
  for (const part of notRun) {
    await emitFn(
      createActionResultEvent({
        result: createRuntimeToolResultFromMessagePart(part, part.toolName),
        sequence: state.sequence,
        stepIndex: state.stepIndex,
        turnId: state.turnId,
      }),
    );
  }
  await emitFn(
    createStepCompletedEvent({
      finishReason: normalizeAssistantStepFinishReason(step.finishReason),
      providerMetadata: extractStepProviderMetadata(step.providerMetadata),
      sequence: state.sequence,
      stepIndex: state.stepIndex,
      turnId: state.turnId,
      usage: extractStepUsage({
        costUsd: extractGatewayCostUsd(step.providerMetadata),
        usage: step.usage,
      }),
    }),
  );
}

/**
 * Projects the AI SDK's `LanguageModelUsage` into the flat `step.completed`
 * event usage shape. Returns `undefined` when the SDK reports no usage.
 */
function extractStepUsage(input: {
  readonly costUsd: number | undefined;
  readonly usage: LanguageModelUsage | undefined;
}):
  | {
      costUsd?: number;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    }
  | undefined {
  const result: {
    costUsd?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  } = {};

  if (input.costUsd !== undefined) result.costUsd = input.costUsd;

  const usage = input.usage;
  if (usage === undefined) {
    return Object.keys(result).length > 0 ? result : undefined;
  }

  if (usage.inputTokens !== undefined) result.inputTokens = usage.inputTokens;
  if (usage.outputTokens !== undefined) result.outputTokens = usage.outputTokens;
  if (usage.inputTokenDetails?.cacheReadTokens !== undefined) {
    result.cacheReadTokens = usage.inputTokenDetails.cacheReadTokens;
  }
  if (usage.inputTokenDetails?.cacheWriteTokens !== undefined) {
    result.cacheWriteTokens = usage.inputTokenDetails.cacheWriteTokens;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function extractStepProviderMetadata(
  providerMetadata: ProviderMetadata | undefined,
): StepCompletedProviderMetadata | undefined {
  const generationId = readGatewayGenerationId(providerMetadata);
  return generationId === undefined ? undefined : { gateway: { generationId } };
}

function extractGatewayCostUsd(providerMetadata: ProviderMetadata | undefined): number | undefined {
  const gateway = readGatewayMetadata(providerMetadata);
  const cost = gateway?.cost;
  if (typeof cost === "number" && Number.isFinite(cost)) {
    return cost;
  }
  if (typeof cost === "string") {
    const parsed = Number(cost);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function readGatewayGenerationId(
  providerMetadata: ProviderMetadata | undefined,
): string | undefined {
  const generationId = readGatewayMetadata(providerMetadata)?.generationId;
  return typeof generationId === "string" && generationId.length > 0 ? generationId : undefined;
}

function readGatewayMetadata(
  providerMetadata: ProviderMetadata | undefined,
): ProviderMetadata[string] | undefined {
  const gateway = providerMetadata?.gateway;
  return gateway && typeof gateway === "object" && !Array.isArray(gateway) ? gateway : undefined;
}
