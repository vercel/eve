import type {
  ContentPart,
  LanguageModelUsage,
  ModelMessage,
  PrepareStepFunction,
  StepResult,
  ToolSet,
  ToolResultPart,
  TypedToolCall,
  TypedToolResult,
} from "ai";
import {
  createActionResultEvent,
  createActionsRequestedEvent,
  createStepCompletedEvent,
} from "#protocol/message.js";
import {
  createRuntimeToolResultFromMessagePart,
  createRuntimeToolResultFromStepResult,
} from "#harness/action-result-helpers.js";
import type { HarnessEmissionState } from "#harness/emission.js";
import { emitStepStarted, normalizeAssistantStepFinishReason } from "#harness/emission.js";
import { extractToolApprovalInputRequests } from "#harness/input-extraction.js";
import {
  type AnthropicCacheMarker,
  applyConversationCacheControl,
  mergeGatewayAutoCaching,
  type PromptCachePath,
} from "#harness/prompt-cache.js";
import { mergeGatewayProviderPin } from "#harness/provider-tools.js";
import { createRuntimeActionRequestFromToolCall } from "#harness/runtime-actions.js";
import type { RuntimeToolResultActionResult } from "#runtime/actions/types.js";
import type { HarnessEmitFn, HarnessSession, ToolLoopHarnessConfig } from "#harness/types.js";
import { contextStorage } from "#context/container.js";
import { isAuthorizationSignal, isPendingAuthorizationToolOutput } from "#harness/authorization.js";
import { readToolInterrupt } from "#harness/tool-interrupts.js";

// ---------------------------------------------------------------------------
// Step result type
// ---------------------------------------------------------------------------

/**
 * The subset of `StepResult` that the harness reads after a step completes.
 *
 * Used by both the streaming (`onStepFinish` callback) and non-streaming
 * (`generateText` result) code paths.
 */
export type HarnessStepResult = Pick<
  StepResult<ToolSet>,
  "content" | "finishReason" | "response" | "text" | "toolCalls" | "toolResults" | "usage"
>;

// ---------------------------------------------------------------------------
// Hook builder input / output
// ---------------------------------------------------------------------------

/**
 * Input for {@link buildStepHooks}.
 */
interface StepHooksInput {
  readonly cachePath: PromptCachePath;
  readonly emit?: HarnessEmitFn;
  readonly emissionState: HarnessEmissionState;
  /**
   * When `false`, `prepareStep` skips the `step.started` emission.
   * Used by the harness recovery path to avoid emitting `step.started`
   * twice when retrying the same step with a degraded toolset.
   *
   * Defaults to `true`.
   */
  readonly emitStepStarted?: boolean;
  /**
   * When set on the `gateway-auto` cache path, merges
   * `providerOptions.gateway.only = [gatewayPinProvider]` so the AI
   * Gateway only routes to the given provider. Used to keep
   * provider-specific tools (e.g. Anthropic's `web_search_20250305`)
   * on a provider that can serve them, converting a transient outage
   * into a clean retryable 503 rather than a fallback-to-incompatible
   * provider 400.
   *
   * Ignored when the author already set `gateway.only` or
   * `gateway.order` on the model reference's provider options.
   */
  readonly gatewayPinProvider?: string;
  readonly marker: AnthropicCacheMarker | undefined;
  readonly session: HarnessSession;
}

/**
 * Composable hooks returned by {@link buildStepHooks}.
 */
interface StepHooks {
  /**
   * `ToolLoopAgent` `onStepFinish` callback.
   *
   * Emits `actions.requested`, `action.result`, and `step.completed` events
   * from the captured step result.
   */
  readonly onStepFinish: (step: StepResult<ToolSet>) => Promise<void>;

  /**
   * `ToolLoopAgent` `prepareStep` callback.
   *
   * Handles `step.started` emission and cache/provider metadata. Compaction
   * happens in the tool-loop before `agent.stream()`.
   */
  readonly prepareStep: PrepareStepFunction<ToolSet>;

  /**
   * Promise that resolves when `onStepFinish` has completed.
   *
   * Await this after consuming the stream to ensure all step events
   * have been emitted before proceeding to post-step handling.
   *
   * Resolves once per hooks instance: a retried model call must rebuild
   * hooks via a fresh `runOneModelCall` attempt. Re-running a call against
   * hooks whose `stepResult` already resolved reads the previous attempt's
   * result, not the retry's.
   *
   * Never settles when the step does not finish — e.g. the AI SDK's
   * incomplete-stream rejection (`NoOutputGeneratedError`) skips
   * `onStepFinish` entirely. Consumers must surface stream errors as
   * throws before awaiting this promise (`emitStreamContent` does), or
   * the await hangs.
   */
  readonly stepResult: Promise<HarnessStepResult>;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Builds composable `prepareStep` and `onStepFinish` closures that
 * own all step-internal work: emission, compaction, and prompt caching.
 *
 * The harness passes these hooks to `ToolLoopAgent` and reads the
 * results via `stepResult` after the agent finishes.
 */
export function buildStepHooks(input: StepHooksInput): StepHooks {
  const session = input.session;
  const emit = input.emit;

  let resolveStep: (step: HarnessStepResult) => void;
  const stepResult = new Promise<HarnessStepResult>((resolve) => {
    resolveStep = resolve;
  });

  // -------------------------------------------------------------------------
  // prepareStep
  //
  // Only handles step.started emission and cache/provider metadata. Compaction
  // runs in the tool-loop before `agent.stream()` so the compacted messages
  // flow through the same `messages` variable the harness uses to rebuild
  // session history — no prepareStep snapshot required.
  // -------------------------------------------------------------------------

  const prepareStep: PrepareStepFunction<ToolSet> = async ({ messages }) => {
    let processed = messages;

    if (emit && input.emitStepStarted !== false) {
      await emitStepStarted(emit, input.emissionState, messages);
    }

    if (input.cachePath.kind === "anthropic-direct" && input.marker) {
      processed = applyConversationCacheControl([...messages], input.marker);
    }

    const stepResult: NonNullable<Awaited<ReturnType<PrepareStepFunction<ToolSet>>>> = {
      messages: processed,
    };

    if (input.cachePath.kind === "gateway-auto") {
      let providerOptions = mergeGatewayAutoCaching(session.agent.modelReference.providerOptions);
      if (input.gatewayPinProvider !== undefined) {
        providerOptions = mergeGatewayProviderPin(providerOptions, input.gatewayPinProvider);
      }
      stepResult.providerOptions = providerOptions as NonNullable<
        typeof stepResult.providerOptions
      >;
    }

    return stepResult;
  };

  return {
    onStepFinish: async (step: StepResult<ToolSet>): Promise<void> => {
      resolveStep(step);
    },
    prepareStep,
    stepResult,
  };
}

// ---------------------------------------------------------------------------
// Step action emission
// ---------------------------------------------------------------------------

/**
 * Emits `actions.requested`, `action.result`, and `step.completed` events
 * from a captured step result.
 *
 * Tool calls and results that match `excludedActionToolNames`, belong to
 * tool-approval requests, or are marked `invalid` by the AI SDK (e.g. the
 * model emitted unparsable JSON) are filtered out of the emitted events.
 * The AI SDK feeds the invalid-call error back to the model on the next
 * step via `step.response.messages` so it can retry with well-formed
 * arguments — the runtime event stream only sees successfully parsed
 * tool calls.
 *
 * `handledInlineToolResultCallIds` lists approval-resume tool-result
 * call ids the stream already handled inline (see `emitStreamContent`).
 * This skips them to avoid double-emission.
 */
export async function emitStepActions(
  emitFn: HarnessEmitFn,
  state: HarnessEmissionState,
  step: HarnessStepResult,
  options: {
    readonly excludedActionToolNames: ReadonlySet<string>;
    readonly handledInlineToolResultCallIds?: ReadonlySet<string>;
    readonly tools: ToolLoopHarnessConfig["tools"];
  },
): Promise<void> {
  const providerExecutedCallIds = new Set(
    (step.toolCalls as TypedToolCall<ToolSet>[])
      .filter(isProviderExecutedToolCall)
      .map((toolCall) => toolCall.toolCallId),
  );
  const excludedCallIds = new Set<string>([
    ...providerExecutedCallIds,
    ...extractToolApprovalInputRequests({
      content: (step.content ?? []) as ContentPart<ToolSet>[],
    }).map((request) => request.action.callId),
    ...(step.toolCalls as TypedToolCall<ToolSet>[])
      .filter(isInvalidToolCall)
      .map((toolCall) => toolCall.toolCallId),
  ]);

  const isExcluded = (toolCallId: string, toolName: string): boolean =>
    excludedCallIds.has(toolCallId) || options.excludedActionToolNames.has(toolName);

  // actions.requested
  const actions = (step.toolCalls as TypedToolCall<ToolSet>[])
    .filter((tc) => !isExcluded(tc.toolCallId, tc.toolName))
    .map((toolCall) =>
      createRuntimeActionRequestFromToolCall({
        toolCall,
        tools: options.tools,
      }),
    );

  if (actions.length > 0) {
    await emitFn(
      createActionsRequestedEvent({
        actions,
        sequence: state.sequence,
        stepIndex: state.stepIndex,
        turnId: state.turnId,
      }),
    );
  }

  const inlineCallIds = options.handledInlineToolResultCallIds;
  const rawOutputByCallId = new Map<string, unknown>(
    (step.toolResults as TypedToolResult<ToolSet>[]).map((toolResult) => [
      toolResult.toolCallId,
      toolResult.output,
    ]),
  );

  for (const result of reconcileToolResults(step)) {
    if (isExcluded(result.callId, result.toolName)) {
      continue;
    }

    if (inlineCallIds?.has(result.callId)) {
      continue;
    }

    const rawOutput = rawOutputByCallId.get(result.callId);
    if (shouldSkipAuthorizationActionResult(result.callId, rawOutput)) {
      continue;
    }

    await emitFn(
      createActionResultEvent({
        result,
        sequence: state.sequence,
        stepIndex: state.stepIndex,
        turnId: state.turnId,
      }),
    );
  }

  // step.completed
  await emitFn(
    createStepCompletedEvent({
      finishReason: normalizeAssistantStepFinishReason(step.finishReason),
      sequence: state.sequence,
      stepIndex: state.stepIndex,
      turnId: state.turnId,
      usage: extractStepUsage(step.usage),
    }),
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when the AI SDK marked the tool call `invalid` (typically
 * because the model emitted unparsable JSON or targeted an unknown tool).
 *
 * Invalid calls have a raw-string or partial `input` payload that cannot
 * satisfy the runtime-action contract. The AI SDK synthesizes a tool-error
 * result for the next model step automatically; callers must skip invalid
 * calls when projecting to `RuntimeActionRequest` values or the harness
 * will throw on the JSON-object invariant.
 */
export function isInvalidToolCall(toolCall: TypedToolCall<ToolSet>): boolean {
  return toolCall.invalid === true;
}

function isProviderExecutedToolCall(toolCall: TypedToolCall<ToolSet>): boolean {
  return toolCall.providerExecuted === true;
}

function reconcileToolResults(step: HarnessStepResult): readonly RuntimeToolResultActionResult[] {
  const resultsByCallId = new Map<string, RuntimeToolResultActionResult>();

  for (const toolResult of step.toolResults as TypedToolResult<ToolSet>[]) {
    if (toolResult.providerExecuted === true) {
      continue;
    }

    resultsByCallId.set(toolResult.toolCallId, createRuntimeToolResultFromStepResult(toolResult));
  }

  for (const part of extractToolResultParts(step.response.messages)) {
    if ((part as { readonly providerExecuted?: boolean }).providerExecuted === true) {
      continue;
    }

    if (resultsByCallId.has(part.toolCallId)) {
      continue;
    }

    resultsByCallId.set(part.toolCallId, createRuntimeToolResultFromMessagePart(part));
  }

  return [...resultsByCallId.values()];
}

function shouldSkipAuthorizationActionResult(callId: string, rawOutput: unknown): boolean {
  if (rawOutput !== undefined && isPendingAuthorizationToolOutput(rawOutput)) {
    return true;
  }
  const ctx = contextStorage.getStore();
  if (ctx === undefined) {
    return false;
  }
  const stashed = readToolInterrupt(ctx, callId);
  return stashed !== undefined && isAuthorizationSignal(stashed);
}

function extractToolResultParts(messages: readonly ModelMessage[]): ToolResultPart[] {
  const parts: ToolResultPart[] = [];

  for (const message of messages) {
    if (message.role !== "tool" || !Array.isArray(message.content)) {
      continue;
    }

    for (const part of message.content) {
      if (part.type === "tool-result") {
        parts.push(part);
      }
    }
  }

  return parts;
}

/**
 * Projects the AI SDK's `LanguageModelUsage` into the flat `step.completed`
 * event usage shape. Returns `undefined` when the SDK reports no usage.
 */
function extractStepUsage(usage: LanguageModelUsage | undefined):
  | {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    }
  | undefined {
  if (usage === undefined) {
    return undefined;
  }

  const result: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  } = {};

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
