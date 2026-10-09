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
import { createRuntimeToolResultFromMessagePart } from "#harness/action-result-helpers.js";
import { callSettledFrom, toJsonValue } from "#harness/call-facts.js";
import { REPLY_TOOL_NAME } from "#protocol/reply-tool.js";
import { isInvalidToolCall } from "#harness/tool-call-input-errors.js";
import type { SessionEvent } from "#protocol/session-event.js";
import type { Usage } from "#protocol/session-events/envelope.js";
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
import { resolveConversationId } from "#shared/conversation-identity.js";
import type { InputRequest } from "#shared/input.js";

// ---------------------------------------------------------------------------
// Step result type
// ---------------------------------------------------------------------------

/**
 * The subset of `StepResult` that the harness reads after a step completes.
 *
 * Used by both the streaming (`onStepEnd` callback) and non-streaming
 * (`generateText` result) code paths.
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
      messages: profile.anthropicCache ? applyConversationCacheControl(messages) : messages,
    };

    const modelReference = requireSessionModelReference(session);
    const providerOptions = resolveCallProviderOptions({
      auth: input.auth ?? contextStorage.getStore()?.get(AuthKey) ?? null,
      conversationId: resolveConversationId(session.rootSessionId ?? session.sessionId),
      profile,
      providerOptions: modelReference.providerOptions,
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
 * Ends a step's run: the calls that didn't run settle with why, then one commit holds the run's
 * structured result, if it has one, its settlement, and its usage. The stream published the calls,
 * and eve published the results of the calls it ran as they settled.
 */
export async function emitStepActions(
  emitFn: HarnessEmitFn,
  state: TurnPosition,
  step: HarnessStepResult,
  notRun: readonly ToolResultPart[],
): Promise<void> {
  const { runId, turnId } = state;
  const scope = runId === undefined ? { turnId } : { runId, turnId };
  for (const part of notRun) {
    await emitFn(
      callSettledFrom(createRuntimeToolResultFromMessagePart(part, part.toolName), { scope }),
    );
  }
  if (runId === undefined) return;
  const commit: SessionEvent[] = [];
  const result = finalOutputOf(step);
  if (result !== undefined) {
    commit.push({
      data: { kind: "result", partId: `${runId}.result`, phase: "reply", runId, value: result },
      scope,
      type: "content.completed",
    });
  }
  const settled: {
    runId: string;
    outcome: "completed";
    finishReason: string;
    generationId?: string;
  } = {
    finishReason: normalizeAssistantStepFinishReason(step.finishReason),
    outcome: "completed",
    runId,
  };
  const generationId = readGatewayGenerationId(step.providerMetadata);
  if (generationId !== undefined) settled.generationId = generationId;
  commit.push({ data: settled, scope, type: "model.settled" });
  const usage = runUsageOf({
    costUsd: extractGatewayCostUsd(step.providerMetadata),
    usage: step.usage,
  });
  if (usage !== undefined) {
    commit.push({
      data: { kind: "model", owner: { runId }, usage },
      scope,
      type: "usage.recorded",
    });
  }
  await emitFn(commit);
}

/** The run's structured result: the input of its valid `eve__reply` call. */
function finalOutputOf(step: HarnessStepResult) {
  const call = (step.toolCalls ?? []).find(
    (candidate) => candidate.toolName === REPLY_TOOL_NAME && !isInvalidToolCall(candidate),
  );
  return call === undefined ? undefined : toJsonValue(call.input);
}

/** A run's usage as `usage.recorded` carries it, or `undefined` when the SDK reported none. */
export function runUsageOf(input: {
  readonly costUsd: number | undefined;
  readonly usage: LanguageModelUsage | undefined;
}): Usage | undefined {
  const { usage } = input;
  if (usage === undefined && input.costUsd === undefined) return undefined;
  const recorded: { -readonly [K in keyof Usage]: Usage[K] } = {
    cacheReadTokens: usage?.inputTokenDetails?.cacheReadTokens ?? 0,
    cacheWriteTokens: usage?.inputTokenDetails?.cacheWriteTokens ?? 0,
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
  };
  if (input.costUsd !== undefined) recorded.costUsd = input.costUsd;
  return recorded;
}

export function extractGatewayCostUsd(
  providerMetadata: ProviderMetadata | undefined,
): number | undefined {
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
