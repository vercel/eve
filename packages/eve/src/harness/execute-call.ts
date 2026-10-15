/**
 * Catalog calls in the harness. Once a step's calls enter the harness, every
 * seam reads an `eve__tool` or `eve__skill` call as the call to the entry it
 * names. Model history keeps the model's own calls.
 */

import type { ModelMessage, TextStreamPart, ToolSet } from "ai";

import type { HarnessStepResult } from "#harness/step-hooks.js";
import type { CallResolver, ResolvedCall, ToolCallLike } from "#harness/types.js";
import { CALL_TOOL_NAME, SKILL_TOOL_NAME } from "#protocol/catalog-tools.js";
import type { ToolExecuteOptions } from "#tools/definition.js";

/**
 * The name each tool call has in model history, by call id. A result written
 * to history carries its call's name there, which is the catalog tool for a
 * call made through one.
 */
export function historyCallNames(messages: readonly ModelMessage[]): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === "tool-call") names.set(part.toolCallId, part.toolName);
    }
  }
  return names;
}

/**
 * Runs a resolved catalog call. eve resolves every call before it runs one, so this runs only
 * for a catalog tool's own `execute`, which no resolved call reaches.
 */
export function runEntryCall(
  resolved: ResolvedCall<ToolCallLike>,
  options: ToolExecuteOptions,
): unknown {
  const { call, definition } = resolved;
  if (definition.execute === undefined) throw new Error(`"${call.toolName}" cannot run.`);
  return definition.execute(call.input, options);
}

/** Every field of a step, so a new one cannot be left out of {@link toEntryStep}. */
type StepFields = { readonly [K in keyof Required<HarnessStepResult>]: HarnessStepResult[K] };

/**
 * The step as the harness reads it: catalog calls become calls to their entries. The response
 * messages, which become history, keep the model's own calls.
 */
export function toEntryStep<T extends ModelMessage>(
  step: HarnessStepResult,
  responseMessages: readonly T[],
  resolve: CallResolver,
): readonly [HarnessStepResult, T[]] {
  // SDK step fields are prototype getters, so each one is read explicitly.
  const entryStep: StepFields = {
    approvalRequests: step.approvalRequests,
    callId: step.callId,
    content: (step.content ?? []).map((part) => toEntryPart(part, resolve)),
    finishReason: step.finishReason,
    invalidInputToolCallIds: step.invalidInputToolCallIds,
    providerMetadata: step.providerMetadata,
    response: step.response,
    signIns: step.signIns,
    text: step.text,
    toolCalls: (step.toolCalls ?? []).map((toolCall) => entryCallOf(toolCall, resolve)),
    toolResults: (step.toolResults ?? []).map((toolResult) => entryCallOf(toolResult, resolve)),
    usage: step.usage,
  };
  return [entryStep, [...responseMessages]];
}

/**
 * The stream as the harness reads it, as {@link toEntryStep} reads the step.
 * A catalog call's input stream is dropped: its entry is known only once the
 * input is complete.
 */
export async function* toEntryStream(
  stream: AsyncIterable<TextStreamPart<ToolSet>>,
  resolve: CallResolver,
): AsyncIterable<TextStreamPart<ToolSet>> {
  const executeInputs = new Set<string>();
  for await (const part of stream) {
    if (
      part.type === "tool-input-start" &&
      (part.toolName === CALL_TOOL_NAME || part.toolName === SKILL_TOOL_NAME)
    ) {
      executeInputs.add(part.id);
      continue;
    }
    if (part.type === "tool-input-delta" && executeInputs.has(part.id)) continue;
    if (part.type === "tool-input-end" && executeInputs.delete(part.id)) continue;
    yield toEntryPart(part, resolve);
  }
}

function entryCallOf<T extends ToolCallLike>(toolCall: T, resolve: CallResolver): T {
  return resolve(toolCall)?.call ?? toolCall;
}

/** A stream or content part, with the call it carries resolved to its entry. */
function toEntryPart<P extends { readonly type: string }>(part: P, resolve: CallResolver): P {
  switch (part.type) {
    case "tool-call":
    case "tool-result":
    case "tool-error":
      return entryCallOf(part as P & ToolCallLike, resolve);
    case "tool-approval-request": {
      const request = part as P & { readonly toolCall?: ToolCallLike };
      if (request.toolCall === undefined) return part;
      return { ...request, toolCall: entryCallOf(request.toolCall, resolve) };
    }
    default:
      return part;
  }
}
