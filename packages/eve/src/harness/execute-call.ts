import type { ModelMessage, TextStreamPart, ToolSet } from "ai";

import type { HarnessStepResult } from "#harness/step-hooks.js";
import type { CallResolver, ResolvedCall, ToolCallLike } from "#harness/types.js";
import { CALL_TOOL_NAME, SKILL_TOOL_NAME } from "#protocol/catalog-tools.js";
import type { ToolExecuteOptions } from "#tools/definition.js";

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

export function runEntryCall(
  resolved: ResolvedCall<ToolCallLike>,
  options: ToolExecuteOptions,
): unknown {
  const { call, definition } = resolved;
  if (definition.execute === undefined) throw new Error(`"${call.toolName}" cannot run.`);
  return definition.execute(call.input, options);
}

type StepFields = { readonly [K in keyof Required<HarnessStepResult>]: HarnessStepResult[K] };

export function toEntryStep<T extends ModelMessage>(
  step: HarnessStepResult,
  responseMessages: readonly T[],
  resolve: CallResolver,
): readonly [HarnessStepResult, T[]] {
  const entryStep: StepFields = {
    approvalRequests: step.approvalRequests,
    policyApprovals: step.policyApprovals,
    promotedTasks: step.promotedTasks,
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
