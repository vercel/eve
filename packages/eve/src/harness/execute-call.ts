/**
 * `execute` calls in the harness. Once a step's calls enter the harness, every
 * seam reads a call through `execute` as the call to the entry it names. Model
 * history keeps the model's own calls.
 */

import type { ModelMessage, Telemetry, TelemetryOptions, TextStreamPart, ToolSet } from "ai";

import { isWorkflowTool } from "#execution/tasks/model-step.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { HarnessStepResult } from "#harness/step-hooks.js";
import { toolCallModelOutput } from "#harness/tool-call-io.js";
import type { CallResolver, ResolvedCall, ToolCallLike } from "#harness/types.js";
import { EXECUTE_TOOL_NAME } from "#protocol/catalog-tools.js";
import type { ToolExecuteOptions } from "#tools/definition.js";

/**
 * The name each tool call has in model history, by call id. A result written
 * to history carries its call's name there, which is `execute` for a call
 * made through it.
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
 * The AI SDK decides per tool name whether to run a call, and it runs every
 * `execute` call. A direct call to a workflow tool or agent never runs in the
 * SDK: the harness dispatches it after the step. Through `execute`, such a
 * call returns this stand-in instead, which never leaves this module: it is
 * dropped from the stream, the step, and telemetry, and the harness then
 * dispatches the call as it does a direct one.
 */
const DISPATCHED = Object.freeze({ dispatched: true });

/** Whether a call runs as a workflow tool or agent the harness dispatches after the step. */
export function dispatchesAfterStep(resolved: ResolvedCall<ToolCallLike> | undefined): boolean {
  return resolved !== undefined && isWorkflowTool(resolved.definition);
}

/** Runs a resolved `execute` call, or stands in for one the harness dispatches. */
export function runEntryCall(
  resolved: ResolvedCall<ToolCallLike>,
  options: ToolExecuteOptions,
): unknown {
  if (dispatchesAfterStep(resolved)) return DISPATCHED;
  const { call, definition } = resolved;
  if (definition.execute === undefined) throw new Error(`"${call.toolName}" cannot run.`);
  return definition.execute(call.input, options);
}

/**
 * The call a tool stub matches. An `execute` call matches as the call to its
 * entry, with the entry's input, so a stub applies to it exactly as to a direct
 * call. A call the harness dispatches after the step has none here: its
 * dispatch applies the stub, as it does for a direct call.
 */
export function stubbedCall(
  call: ToolCallLike,
  resolved: ResolvedCall<ToolCallLike> | undefined,
): ToolCallLike | undefined {
  if (resolved === undefined) return call;
  return dispatchesAfterStep(resolved) ? undefined : resolved.call;
}

/** The model output of a call's result; a stand-in's output is dropped with it. */
export function entryModelOutput(
  definition: Pick<HarnessToolDefinition, "name" | "toModelOutput">,
  output: unknown,
  toolCallId: string | undefined,
): ReturnType<typeof toolCallModelOutput> {
  return output === DISPATCHED
    ? Promise.resolve({ type: "json", value: null })
    : toolCallModelOutput(definition, output, toolCallId);
}

/** Every field of a step, so a new one cannot be left out of {@link toEntryStep}. */
type StepFields = { readonly [K in keyof Required<HarnessStepResult>]: HarnessStepResult[K] };

/**
 * The step as the harness reads it: calls through `execute` become calls to
 * their entries and stand-in results are dropped. The response messages, which
 * become history, keep the model's own calls.
 */
export function toEntryStep<T extends ModelMessage>(
  step: HarnessStepResult,
  responseMessages: readonly T[],
  resolve: CallResolver,
): readonly [HarnessStepResult, T[]] {
  const dispatched = new Set(
    (step.toolResults ?? [])
      .filter((toolResult) => toolResult.output === DISPATCHED)
      .map((toolResult) => toolResult.toolCallId),
  );
  const kept = (part: { readonly toolCallId?: string; readonly type: string }) =>
    part.type !== "tool-result" || !dispatched.has(part.toolCallId!);
  // SDK step fields are prototype getters, so each one is read explicitly.
  const entryStep: StepFields = {
    content: (step.content ?? []).filter(kept).map((part) => toEntryPart(part, resolve)),
    finishReason: step.finishReason,
    invalidInputToolCallIds: step.invalidInputToolCallIds,
    providerMetadata: step.providerMetadata,
    response: { ...step.response, messages: withoutResults(step.response.messages, kept) },
    text: step.text,
    toolCalls: (step.toolCalls ?? []).map((toolCall) => entryCallOf(toolCall, resolve)),
    toolResults: (step.toolResults ?? [])
      .filter(kept)
      .map((toolResult) => entryCallOf(toolResult, resolve)),
    usage: step.usage,
  };
  return [entryStep, withoutResults(responseMessages, kept)];
}

/**
 * The stream as the harness reads it, as {@link toEntryStep} reads the step.
 * An `execute` call's input stream is dropped: its entry is known only once
 * the input is complete.
 */
export async function* toEntryStream(
  stream: AsyncIterable<TextStreamPart<ToolSet>>,
  resolve: CallResolver,
): AsyncIterable<TextStreamPart<ToolSet>> {
  const executeInputs = new Set<string>();
  for await (const part of stream) {
    if (part.type === "tool-input-start" && part.toolName === EXECUTE_TOOL_NAME) {
      executeInputs.add(part.id);
      continue;
    }
    if (part.type === "tool-input-delta" && executeInputs.has(part.id)) continue;
    if (part.type === "tool-input-end" && executeInputs.delete(part.id)) continue;
    if (part.type === "tool-result" && part.output === DISPATCHED) continue;
    yield toEntryPart(part, resolve);
  }
}

/**
 * Telemetry as the harness reports it. Integrations see each call through
 * `execute` as the call to its entry, and never see a stand-in run: a direct
 * call to the same entry never runs in the SDK.
 */
export function toEntryTelemetry(
  telemetry: TelemetryOptions | undefined,
  resolve: CallResolver,
): TelemetryOptions | undefined {
  const integrations = telemetry?.integrations;
  if (integrations === undefined) return telemetry;
  const list = Array.isArray(integrations) ? integrations : [integrations];
  const hiddenCallIds = new Set<string>();
  return {
    ...telemetry,
    integrations: list.map((integration) =>
      entryToolExecutions(integration, resolve, hiddenCallIds),
    ),
  };
}

function entryToolExecutions(
  integration: Telemetry,
  resolve: CallResolver,
  hiddenCallIds: Set<string>,
): Telemetry {
  const { executeTool, onToolExecutionEnd, onToolExecutionStart } = integration;
  if (!executeTool && !onToolExecutionEnd && !onToolExecutionStart) return integration;
  type ExecuteToolOptions = Parameters<NonNullable<Telemetry["executeTool"]>>[0];
  type ToolExecutionEvent = {
    readonly toolCall: ToolCallLike & { readonly toolCallId: string };
  };
  const reportAsEntry =
    <E extends ToolExecutionEvent>(report: ((event: E) => unknown) | undefined) =>
    (event: E) => {
      const resolved = resolve(event.toolCall);
      if (dispatchesAfterStep(resolved)) {
        hiddenCallIds.add(event.toolCall.toolCallId);
        return undefined;
      }
      return report?.call(integration, { ...event, toolCall: resolved?.call ?? event.toolCall });
    };
  return Object.create(integration, {
    executeTool: {
      value(options: ExecuteToolOptions) {
        return hiddenCallIds.has(options.toolCallId) || executeTool === undefined
          ? options.execute()
          : executeTool.call(integration, options);
      },
    },
    onToolExecutionEnd: { value: reportAsEntry(onToolExecutionEnd) },
    onToolExecutionStart: { value: reportAsEntry(onToolExecutionStart) },
  }) as Telemetry;
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

function withoutResults<T extends ModelMessage>(
  messages: readonly T[],
  kept: (part: { readonly toolCallId?: string; readonly type: string }) => boolean,
): T[] {
  return messages.flatMap((message) => {
    if (message.role !== "tool") return [message];
    const content = message.content.filter(kept);
    return content.length === 0 ? [] : [{ ...message, content }];
  });
}
