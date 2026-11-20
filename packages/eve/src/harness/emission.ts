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
import { announcedKind } from "#harness/call-facts.js";
import { requestCall, settleCall } from "#harness/session-machine/calls.js";
import { completeParts } from "#harness/session-machine/content.js";
import type { FactOf } from "#protocol/session-events/facts.js";
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
import type {
  RuntimeToolCallActionRequest,
  RuntimeToolResultActionResult,
} from "#shared/action-types.js";
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

interface EmittedStreamContent {
  readonly invalidInputToolCallIds: ReadonlySet<string>;
  readonly trailingInlineToolResultParts: readonly InlineToolResultPart[];
}

interface StreamActionEmissionOptions {
  readonly excludedActionToolNames: ReadonlySet<string>;
  readonly held?: boolean;
  readonly finalReplyOnly?: boolean;
  readonly sessionCall: (callId: string) => CallRow | undefined;
  readonly tools: HarnessToolLookup;
  readonly interruptSignal?: AbortSignal;
}

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

function finalPhase(finishReason: AssistantStepFinishReason, held: boolean) {
  if (finishReason === "tool-calls") return "narration";
  if (held && finishReason === "stop") return "narration";
  return "reply";
}

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
    await emitFn(completeParts([{ kind, partId, phase, runId, value }]));
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
    await emitFn(
      requestCall({
        action,
        owner: { runId },
        label: projection.presentationLabel,
        hidden: projection.hidden,
      }),
    );
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

  const emitInvalidCall = async (
    action: RuntimeToolCallActionRequest,
    result: RuntimeToolResultActionResult,
  ): Promise<void> => {
    emittedActionCallIds.add(action.callId);
    const message =
      typeof result.output === "string" ? result.output : JSON.stringify(result.output ?? null);
    await emitFn(
      requestCall({
        action,
        hidden: options?.tools.get(action.toolName)?.label === false,
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
    await emitFn(settleCall(result, { label: resultPresentation }));
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
            options.tools.get(part.toolName)?.behavior?.handling?.kind === "provider-tool" ||
            options.excludedActionToolNames.has(part.toolName) ||
            options.tools.get(part.toolName)?.label === false
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
          streamError = normalizeModelStreamError(part.error);
          break;
        case "abort":
          throw new DOMException(part.reason ?? "The model stream was aborted.", "AbortError");
        default:
          break;
      }
    }
  } catch (error) {
    if (options?.interruptSignal?.aborted === true) {
      const completed: FactOf<"content.completed">["data"][] = [];
      if (reasoningPartId !== undefined && currentReasoning.length > 0)
        completed.push({
          partId: reasoningPartId,
          runId,
          kind: "reasoning",
          phase: "narration",
          value: currentReasoning,
          interrupted: true,
        });
      if (messagePartId !== undefined && currentMessage.length > 0)
        completed.push({
          partId: messagePartId,
          runId,
          kind: "text",
          phase: "narration",
          value: currentMessage,
          interrupted: true,
        });
      if (completed.length > 0) await emitFn(completeParts(completed));
    }
    throw error;
  }

  await providerActionBatch.flush();

  if (streamError !== undefined) {
    throw streamError;
  }

  await flushCurrentReasoning();

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
