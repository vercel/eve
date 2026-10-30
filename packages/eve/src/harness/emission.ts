import type {
  ModelMessage,
  TextStreamPart,
  ToolSet,
  TypedToolCall,
  TypedToolError,
  TypedToolResult,
} from "ai";

type ToolResponsePart = Extract<ModelMessage, { role: "tool" }>["content"][number];
type InlineToolResultPart = Extract<ToolResponsePart, { type: "tool-result" }>;

import type { AssistantStepFinishReason } from "#harness/finish-reason.js";
import { announcedKind, callRequested, callSettledFrom } from "#harness/call-facts.js";
import type { SessionEvent } from "#protocol/session-event.js";
import type { CallRow } from "#protocol/session-projection/tables.js";
import { TASK_WAIT_TOOL_NAME } from "#protocol/task-tools.js";
import type { JsonObject } from "#shared/json.js";
import {
  createRuntimeToolResultFromStepResult,
  createRuntimeToolResultFromToolError,
  createToolResultMessagePartFromToolError,
} from "#harness/action-result-helpers.js";
import {
  createInvalidToolCallInputError,
  isInvalidToolCall,
  resolveProviderToolCallRequest,
} from "#harness/tool-call-input-errors.js";
import type { RuntimeToolResultActionResult } from "#shared/action-types.js";
import {
  createPresentedRuntimeActionRequestFromToolCall,
  type RuntimeActionRequestProjection,
} from "#harness/action-presentation.js";
import { projectToolLabel } from "#harness/action-presentation.js";
import { createProviderStreamActionBatch } from "#harness/stream-actions.js";
import { normalizeModelStreamError } from "#harness/model-call/errors.js";
import { createOrderedStreamEmitter } from "#harness/ordered-stream-emitter.js";
import { interruptStreamOnFailure } from "#harness/interruptible-stream.js";
import type { TurnPosition } from "#harness/session-machine/view.js";
import type { HarnessEmitFn, HarnessToolLookup } from "#harness/types.js";
import { normalizeAssistantStepFinishReason } from "#harness/finish-reason.js";

/** The calls of one step's `fullStream` whose input was invalid, and their results. */
interface EmittedStreamContent {
  readonly invalidInputToolCallIds: ReadonlySet<string>;
  readonly trailingInlineToolResultParts: readonly InlineToolResultPart[];
}

interface StreamActionEmissionOptions {
  readonly excludedActionToolNames: ReadonlySet<string>;
  /**
   * The turn holds while its tasks work and its caller reads only the final reply, so a text step
   * can't end it: its text narrates, and only the reply after the tasks report is the turn's.
   */
  readonly held?: boolean;
  /** A child or schedule's caller reads only the final reply, including at an explicit task wait. */
  readonly finalReplyOnly?: boolean;
  /** The session's call with this id, as its view holds it now. */
  readonly sessionCall: (callId: string) => CallRow | undefined;
  readonly tools: HarnessToolLookup;
  /** A deliberate turn cancel or steering interrupt, not a provider failure/retry. */
  readonly interruptSignal?: AbortSignal;
}

/**
 * Consumes the AI SDK `fullStream` and emits real-time text and reasoning
 * events.
 *
 * Emits local tool events in source order. Provider calls that arrive in one
 * stream batch into one request event before their first result. A result
 * without a streamed call resumes a call from an earlier step.
 */
export async function emitStreamContent(
  emitFn: HarnessEmitFn,
  state: TurnPosition,
  fullStream: AsyncIterable<TextStreamPart<ToolSet>>,
  options?: StreamActionEmissionOptions,
): Promise<EmittedStreamContent> {
  const orderedEmitter = createOrderedStreamEmitter(emitFn);
  const providerActionBatch = createProviderStreamActionBatch({
    emitFn: orderedEmitter.emit,
    state,
  });
  try {
    return await consumeStreamContent(
      orderedEmitter.emit,
      state,
      interruptStreamOnFailure(fullStream, orderedEmitter.failureSignal),
      providerActionBatch,
      options,
    );
  } finally {
    try {
      await providerActionBatch.cancel();
    } finally {
      await orderedEmitter.closeAndDrain();
    }
  }
}

/**
 * Whether the run's last text replies. Text the turn continues after narrates: text before calls,
 * and a held turn's text in a session whose caller reads only the final reply. A person reads a
 * held turn's text as a reply.
 */
function finalPhase(finishReason: AssistantStepFinishReason, held: boolean) {
  if (finishReason === "tool-calls") return "narration";
  if (held && finishReason === "stop") return "narration";
  return "reply";
}

/** A root session's text before `eve__task_wait` is a reply the person reads while the turn waits. */
function textPhaseBefore(toolName: string, finalReplyOnly: boolean): "narration" | "reply" {
  return toolName === TASK_WAIT_TOOL_NAME && !finalReplyOnly ? "reply" : "narration";
}

async function consumeStreamContent(
  emitFn: HarnessEmitFn,
  state: TurnPosition,
  fullStream: AsyncIterable<TextStreamPart<ToolSet>>,
  providerActionBatch: ReturnType<typeof createProviderStreamActionBatch>,
  options?: StreamActionEmissionOptions,
): Promise<EmittedStreamContent> {
  const runId = state.runId ?? `${state.turnId}.run`;
  const scope = { runId, turnId: state.turnId };
  let partCount = 0;
  const nextPartId = () => `${runId}.${String(partCount++)}`;
  let currentReasoning = "";
  let reasoningPartId: string | undefined;
  let currentMessage = "";
  let messagePartId: string | undefined;
  let finishReason: AssistantStepFinishReason = "stop";
  let streamError: Error | undefined;
  const emittedActionCallIds = new Set<string>();
  const emittedActionResultCallIds = new Set<string>();
  const providerToolCallIdsSeen = new Set<string>();
  const invalidInputToolCallIds = new Set<string>();
  const trailingInlineToolResultParts: InlineToolResultPart[] = [];
  const actionInputs = new Map<string, JsonObject>();
  const streamingActionInputs = new Map<string, { toolName: string; announced: boolean }>();

  const completePart = async (
    partId: string,
    kind: "text" | "reasoning",
    value: string,
    phase: "narration" | "reply",
  ): Promise<void> => {
    await emitFn({ data: { kind, partId, phase, runId, value }, type: "content.completed" });
  };

  const flushCurrentMessage = async (phase: "narration" | "reply" = "narration"): Promise<void> => {
    if (currentMessage.length === 0 || messagePartId === undefined) {
      return;
    }
    await completePart(messagePartId, "text", currentMessage, phase);
    currentMessage = "";
    messagePartId = undefined;
  };

  const flushCurrentReasoning = async (): Promise<void> => {
    if (currentReasoning.trim().length > 0 && reasoningPartId !== undefined) {
      await completePart(reasoningPartId, "reasoning", currentReasoning, "narration");
    }
    currentReasoning = "";
    reasoningPartId = undefined;
  };

  const emitActionInput = async (callId: string, delta: string): Promise<void> => {
    const input = streamingActionInputs.get(callId);
    if (input === undefined) return;
    const event: SessionEvent = input.announced
      ? { data: { callId, delta }, type: "call.input" }
      : {
          data: {
            callId,
            delta,
            kind: announcedKind(input.toolName, options?.tools.get(input.toolName)),
            name: input.toolName,
          },
          scope,
          type: "call.input",
        };
    input.announced = true;
    await emitFn(event);
  };

  const emitActionRequest = async (projection: RuntimeActionRequestProjection): Promise<void> => {
    const { action } = projection;
    if (emittedActionCallIds.has(action.callId)) {
      return;
    }

    if (currentMessage.trim().length > 0) {
      await flushCurrentMessage(
        action.kind === "tool-call"
          ? textPhaseBefore(action.toolName, options?.finalReplyOnly === true)
          : "narration",
      );
    }

    emittedActionCallIds.add(action.callId);
    actionInputs.set(action.callId, action.input);
    await emitFn(callRequested({ action, owner: { runId }, label: projection.presentationLabel }));
  };

  const collectProviderToolCall = async (toolCall: {
    readonly input?: unknown;
    readonly toolCallId: string;
    readonly toolName: string;
  }): Promise<void> => {
    if (providerToolCallIdsSeen.has(toolCall.toolCallId)) {
      return;
    }
    providerToolCallIdsSeen.add(toolCall.toolCallId);
    if (emittedActionCallIds.has(toolCall.toolCallId)) {
      return;
    }
    emittedActionCallIds.add(toolCall.toolCallId);

    if (currentMessage.trim().length > 0) {
      await flushCurrentMessage();
    }

    const resolved = resolveProviderToolCallRequest(toolCall, options?.tools ?? new Map());
    if (resolved.toolError !== undefined) {
      invalidInputToolCallIds.add(toolCall.toolCallId);
      await emitInvalidCall(
        { callId: toolCall.toolCallId, input: {}, kind: "tool-call", toolName: toolCall.toolName },
        createRuntimeToolResultFromToolError(resolved.toolError),
      );
      trailingInlineToolResultParts.push(
        createToolResultMessagePartFromToolError(resolved.toolError),
      );
      return;
    }

    actionInputs.set(resolved.request.action.callId, resolved.request.action.input);
    providerActionBatch.observe(resolved.request);
  };

  /**
   * Settles a provider call with its result or error. A provider can answer a call an earlier run
   * introduced at the start of a later response: that call isn't introduced again, and once an
   * abandoned attempt settled it, the retry's copy of the answer publishes nothing.
   */
  const settleProviderCall = async (
    toolCall: Parameters<typeof collectProviderToolCall>[0],
    result: RuntimeToolResultActionResult,
  ): Promise<void> => {
    const held = options?.sessionCall(toolCall.toolCallId);
    if (held?.status === "settled") return;
    if (held === undefined) await collectProviderToolCall(toolCall);
    await providerActionBatch.flush();
    await emitActionResult(result);
  };

  /** A call whose input didn't validate is introduced with its error, and fails at once. */
  const emitInvalidCall = async (
    action: Parameters<typeof callRequested>[0]["action"],
    result: RuntimeToolResultActionResult,
  ): Promise<void> => {
    emittedActionCallIds.add(action.callId);
    const message =
      typeof result.output === "string" ? result.output : JSON.stringify(result.output ?? null);
    await emitFn(
      callRequested({
        action,
        inputError: { code: "INVALID_TOOL_INPUT", message },
        owner: { runId },
      }),
    );
    await emitActionResult(result);
  };

  const emitActionResult = async (result: RuntimeToolResultActionResult): Promise<void> => {
    if (emittedActionResultCallIds.has(result.callId)) {
      return;
    }
    emittedActionResultCallIds.add(result.callId);
    const resultPresentation =
      result.isError === true
        ? undefined
        : projectToolLabel(
            options?.tools.get(result.toolName),
            "complete",
            actionInputs.get(result.callId),
            result.output,
          );
    await emitFn(callSettledFrom(result, { label: resultPresentation }));
  };

  const emitToolCall = async (toolCall: TypedToolCall<ToolSet>): Promise<void> => {
    if (isInvalidToolCall(toolCall)) {
      invalidInputToolCallIds.add(toolCall.toolCallId);
      return;
    }
    if (options === undefined || options.excludedActionToolNames.has(toolCall.toolName)) {
      return;
    }

    try {
      await emitActionRequest(
        createPresentedRuntimeActionRequestFromToolCall({
          toolCall,
          tools: options.tools,
        }),
      );
    } catch (error) {
      if (error instanceof TypeError) {
        const toolError = createInvalidToolCallInputError({ error, toolCall });
        invalidInputToolCallIds.add(toolCall.toolCallId);
        if (currentMessage.trim().length > 0) {
          await flushCurrentMessage();
        }
        await emitInvalidCall(
          {
            callId: toolCall.toolCallId,
            input: {},
            kind: "tool-call",
            toolName: toolCall.toolName,
          },
          createRuntimeToolResultFromToolError(toolError),
        );
        trailingInlineToolResultParts.push(createToolResultMessagePartFromToolError(toolError));
        return;
      }
      throw error;
    }
  };

  try {
    for await (const part of fullStream) {
      if (streamError !== undefined) {
        continue;
      }

      switch (part.type) {
        case "reasoning-delta": {
          await providerActionBatch.flush();
          currentReasoning += part.text;
          const announces = reasoningPartId === undefined;
          reasoningPartId ??= nextPartId();
          await emitFn(
            announces
              ? {
                  data: { delta: part.text, kind: "reasoning", partId: reasoningPartId },
                  scope,
                  type: "content.delta",
                }
              : { data: { delta: part.text, partId: reasoningPartId }, type: "content.delta" },
          );
          break;
        }
        case "text-delta": {
          await providerActionBatch.flush();
          // Flush accumulated reasoning before text begins.
          await flushCurrentReasoning();
          currentMessage += part.text;
          const announces = messagePartId === undefined;
          messagePartId ??= nextPartId();
          await emitFn(
            announces
              ? {
                  data: { delta: part.text, kind: "text", partId: messagePartId },
                  scope,
                  type: "content.delta",
                }
              : { data: { delta: part.text, partId: messagePartId }, type: "content.delta" },
          );
          break;
        }
        case "tool-input-start": {
          if (
            options === undefined ||
            part.providerExecuted === true ||
            // AI Gateway streams a provider tool's input unflagged, under an id its call never uses.
            options.tools.get(part.toolName)?.behavior?.handling?.kind === "provider-tool" ||
            options.excludedActionToolNames.has(part.toolName)
          ) {
            streamingActionInputs.delete(part.id);
            break;
          }
          await providerActionBatch.flush();
          if (currentMessage.trim().length > 0) {
            await flushCurrentMessage(
              textPhaseBefore(part.toolName, options.finalReplyOnly === true),
            );
          }
          streamingActionInputs.set(part.id, { announced: false, toolName: part.toolName });
          break;
        }
        case "tool-input-delta": {
          if (!streamingActionInputs.has(part.id)) {
            break;
          }
          await providerActionBatch.flush();
          await emitActionInput(part.id, part.delta);
          break;
        }
        case "tool-input-end":
          streamingActionInputs.delete(part.id);
          break;
        case "tool-call": {
          const toolCall = part as TypedToolCall<ToolSet>;
          streamingActionInputs.delete(toolCall.toolCallId);
          if (toolCall.providerExecuted === true) {
            await collectProviderToolCall(toolCall);
          } else {
            await providerActionBatch.flush();
            await emitToolCall(toolCall);
          }
          break;
        }
        // eve runs local calls after the stream, so only the provider's own results and errors
        // arrive here.
        case "tool-result": {
          const providerResult = part as TypedToolResult<ToolSet>;
          if (providerResult.providerExecuted !== true || providerResult.preliminary === true)
            break;
          await settleProviderCall(
            {
              input: "input" in providerResult ? providerResult.input : undefined,
              toolCallId: providerResult.toolCallId,
              toolName: providerResult.toolName,
            },
            createRuntimeToolResultFromStepResult(providerResult),
          );
          break;
        }
        case "tool-error": {
          const toolError = part as TypedToolError<ToolSet>;
          if (toolError.providerExecuted !== true) break;
          await settleProviderCall(toolError, createRuntimeToolResultFromToolError(toolError));
          break;
        }
        case "finish-step":
          finishReason = normalizeAssistantStepFinishReason(part.finishReason);
          await providerActionBatch.flush();
          break;
        case "error":
          // `part.error` is typed as `unknown` — AI SDK providers emit
          // whatever the upstream service threw. Coerce through `toError`
          // so plain-object shapes (structured-clone survivors, typed
          // gateway payloads) keep their `message`, `name`, `stack`, and
          // `cause` instead of degrading to `new Error("[object Object]")`.
          streamError = normalizeModelStreamError(part.error);
          break;
        case "abort":
          // The SDK does not resolve step results for aborted in-flight steps.
          throw new DOMException(part.reason ?? "The model stream was aborted.", "AbortError");
        default:
          break;
      }
    }
  } catch (error) {
    // Interrupted text stands; a failed/retried attempt instead leaves its incomplete previews
    // behind. Complete the streamed prefixes as one content transition before the run closes.
    if (options?.interruptSignal?.aborted === true) {
      const completed: SessionEvent[] = [];
      if (reasoningPartId !== undefined && currentReasoning.length > 0)
        completed.push({
          type: "content.completed",
          data: {
            partId: reasoningPartId,
            runId,
            kind: "reasoning",
            phase: "narration",
            value: currentReasoning,
            interrupted: true,
          },
        });
      if (messagePartId !== undefined && currentMessage.length > 0)
        completed.push({
          type: "content.completed",
          data: {
            partId: messagePartId,
            runId,
            kind: "text",
            phase: "narration",
            value: currentMessage,
            interrupted: true,
          },
        });
      if (completed.length > 0) await emitFn(completed);
    }
    throw error;
  }

  await providerActionBatch.flush();

  if (streamError !== undefined) {
    throw streamError;
  }

  await flushCurrentReasoning();

  // Text a content filter cut off never completes: its preview goes with the run.
  if (
    finishReason !== "content-filter" &&
    currentMessage.trim().length > 0 &&
    messagePartId !== undefined
  ) {
    await completePart(
      messagePartId,
      "text",
      currentMessage,
      finalPhase(finishReason, options?.held === true),
    );
  }

  return { invalidInputToolCallIds, trailingInlineToolResultParts };
}
