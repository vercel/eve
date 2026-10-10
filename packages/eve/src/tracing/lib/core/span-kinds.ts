import {
  identityAttributes,
  usageAttributes,
  frameworkAttributes,
  namingAttributes,
  runtimeContextAttributes,
} from "./attributes.js";
export const invocationName = (name?: string) =>
  name === undefined ? "invoke_agent" : `invoke_agent ${name}`;
const modelName = (name: string) => `chat ${name}`;
const toolName = (name: string) => `execute_tool ${name}`;
const SPAN_NAMES = {
  approval: "agent.approval",
  step: "agent.step",
} as const;
const CONTENT_FIELDS = {
  toolArguments: "gen_ai.tool.call.arguments",
  toolResult: "gen_ai.tool.call.result",
  approvalRequest: "agent.approval.request",
  approvalResponse: "agent.approval.response",
  memoryRecords: "gen_ai.memory.records",
} as const;
export function applyAttributes(
  span: { setAttribute(key: string, value: Exclude<Attributes[string], undefined>): unknown },
  attributes: Attributes,
): void {
  for (const [key, value] of Object.entries(attributes))
    if (value !== undefined) span.setAttribute(key, value);
}
import type { ContentSerializer, ModelResult } from "./types.js";
import { withoutDeclinedContent } from "./content-policy.js";
import type { ScopeData, ScopeIdentity, ScopeRecord, ScopeTerminal } from "./types.js";
import type { Attributes, CaptureDecision, PreparedSpan } from "./types.js";
import type { TraceOperation } from "./writer.js";

interface KindContext {
  identity: ScopeIdentity;
  attributes: Attributes;
  attempt: { turnId: string; index: number; attempt: number };
  capture: CaptureDecision;
  serializer: ContentSerializer;
}
type Kind<K extends ScopeData["type"]> = {
  parents: readonly ScopeData["type"][];
  prepare(
    data: Extract<ScopeData, { type: K }>,
    context: KindContext,
  ): Pick<PreparedSpan, "name" | "kind" | "attributes">;
  complete?(
    span: TraceOperation,
    data: Extract<ScopeData, { type: K }>,
    result: ScopeTerminal,
    context: CompletionContext,
  ): void;
  redact?(data: Extract<ScopeData, { type: K }>, capture: CaptureDecision): ScopeData;
};
interface CompletionContext {
  capture: CaptureDecision;
  serializer: ContentSerializer;
  outcome: string;
  startTimeMs: number;
}
function attemptAttributes(context: KindContext): Attributes {
  return {
    "agent.turn.id": context.attempt.turnId,
    "agent.step.index": context.attempt.index,
    "agent.step.attempt": context.attempt.attempt,
  };
}
function permitted(
  attributes: Attributes | undefined,
  capture: CaptureDecision,
): Attributes | undefined {
  return (withoutDeclinedContent(attributes ?? {}, capture) ?? attributes) as
    | Attributes
    | undefined;
}
function toolInput(arguments_: unknown, context: KindContext): Attributes {
  return {
    [CONTENT_FIELDS.toolArguments]: context.capture.recordInputs
      ? context.serializer.json(arguments_)
      : undefined,
  };
}
function toolOutput(span: TraceOperation, result: ScopeTerminal, context: CompletionContext): void {
  if (context.capture.recordOutputs)
    applyAttributes(span, { [CONTENT_FIELDS.toolResult]: context.serializer.json(result.output) });
}
const kinds: { [K in ScopeData["type"]]: Kind<K> } = {
  activation: {
    parents: [],
    prepare({ options }, context) {
      const { identity, capture } = context;
      return {
        name: invocationName(identity.agentName),
        attributes: {
          ...context.attributes,
          ...frameworkAttributes(identity.framework),
          ...namingAttributes(invocationName(identity.agentName), "invoke_agent"),
          "agent.channel.kind": options.channel?.kind,
          "agent.session.origin": options.channel?.origin,
          "agent.name": identity.agentName,
          "gen_ai.agent.name": identity.agentName,
          "gen_ai.operation.name": "invoke_agent",
          "agent.turn.id": identity.turnId,
          "agent.turn.sequence": options.sequence,
          "agent.run.type": options.subagent ? "subagent" : "session",
          "agent.parent_call.id": options.parentCallId,
          "agent.parent_run.id": options.parentRunId,
          "agent.subagent.name": options.subagentName,
          "agent.trace.content.input": capture.recordInputs,
          "agent.trace.content.output": capture.recordOutputs,
          ...permitted(options.attributes, capture),
        },
      };
    },
    complete(span, _data, result, context) {
      span.addEvent("turn.started", undefined, context.startTimeMs);
      if (result.outcomeUnknown !== true || result.failed === true)
        span.addEvent(`turn.${context.outcome}`, undefined, result.endTimeMs);
    },
    redact(data, capture) {
      return {
        ...data,
        options: { ...data.options, attributes: permitted(data.options.attributes, capture) },
      };
    },
  },
  step: {
    parents: ["activation"],
    prepare({ options }, context) {
      return {
        name: SPAN_NAMES.step,
        attributes: {
          ...context.attributes,
          ...frameworkAttributes(context.identity.framework),
          ...attemptAttributes(context),
          ...namingAttributes(SPAN_NAMES.step),
          "agent.name": context.identity.agentName,
          "agent.channel.kind":
            options.channel?.kind === "unknown" ? undefined : options.channel?.kind,
          "agent.session.origin":
            options.channel?.kind === "unknown" ? undefined : options.channel?.origin,
          ...runtimeContextAttributes(options.runtimeContext),
        },
      };
    },
    complete(span, _data, result) {
      span.addEvent(result.failed ? "step.failed" : "step.completed", undefined, result.endTimeMs);
    },
  },
  model: {
    parents: ["step"],
    prepare({ options }, context) {
      return {
        name: modelName(options.modelId),
        kind: "CLIENT",
        attributes: {
          ...context.attributes,
          ...namingAttributes(modelName(options.modelId), "chat"),
          "gen_ai.agent.name": context.identity.agentName,
          "gen_ai.operation.name": "chat",
          "gen_ai.provider.name": options.provider,
          "gen_ai.request.model": options.modelId,
          ...runtimeContextAttributes(options.runtimeContext),
          ...(context.capture.recordInputs && options.messages !== undefined
            ? {
                "gen_ai.input.messages": context.serializer.inputMessages(options.messages),
                "gen_ai.system_instructions": context.serializer.instructions(options.instructions),
              }
            : undefined),
          "gen_ai.tool.definitions": context.capture.recordInputs
            ? context.serializer.toolDefinitions(options.tools)
            : undefined,
        },
      };
    },
    complete(span, _data, result, context) {
      if (result.model !== undefined)
        applyAttributes(
          span,
          modelResultAttributes(result.model, context.serializer, context.capture.recordOutputs),
        );
    },
    redact(data, capture) {
      return capture.recordInputs
        ? data
        : {
            ...data,
            options: {
              ...data.options,
              messages: undefined,
              instructions: undefined,
              tools: undefined,
            },
          };
    },
  },
  tool: {
    parents: ["step", "tool"],
    prepare({ options }, context) {
      const delegates = options.kind === "subagent-call" || options.kind === "remote-agent-call";
      return {
        name: toolName(options.name),
        kind: options.kind === "remote-agent-call" ? "CLIENT" : "INTERNAL",
        attributes: {
          ...context.attributes,
          ...frameworkAttributes(context.identity.framework),
          ...attemptAttributes(context),
          ...namingAttributes(toolName(options.name), "execute_tool"),
          "gen_ai.agent.name": delegates ? options.name : context.identity.agentName,
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.call.id": options.callId,
          "gen_ai.tool.name": options.name,
          "gen_ai.tool.type": "function",
          "agent.tool.kind": options.kind,
          "agent.tool.parent_call_id": options.parentCallId,
          "agent.invocation.role": delegates ? "caller" : undefined,
          ...toolInput(options.arguments, context),
        },
      };
    },
    complete(span, _data, result, context) {
      if (result.outcome !== undefined)
        applyAttributes(span, { "agent.tool.outcome": result.outcome });
      toolOutput(span, result, context);
    },
    redact(data, capture) {
      return capture.recordInputs
        ? data
        : { ...data, options: { ...data.options, arguments: undefined } };
    },
  },
  approval: {
    parents: ["tool"],
    prepare({ options }, context) {
      return {
        name: SPAN_NAMES.approval,
        attributes: {
          ...context.attributes,
          ...frameworkAttributes(context.identity.framework),
          ...attemptAttributes(context),
          ...namingAttributes(SPAN_NAMES.approval),
          "gen_ai.tool.call.id": options.callId,
          "gen_ai.tool.name": options.toolName,
          "agent.approval.kind": "tool-approval",
          "agent.approval.request_id": options.requestId,
          [CONTENT_FIELDS.approvalRequest]: context.capture.recordInputs
            ? context.serializer.json(options.request)
            : undefined,
        },
      };
    },
    complete(span, _data, result, context) {
      if (context.capture.recordOutputs)
        applyAttributes(span, {
          [CONTENT_FIELDS.approvalResponse]: context.serializer.json(result.response),
        });
    },
    redact(data, capture) {
      return capture.recordInputs
        ? data
        : { ...data, options: { ...data.options, request: undefined } };
    },
  },
  memory: {
    parents: ["activation", "step", "tool"],
    prepare({ options }, context) {
      return {
        name: options.operation,
        kind: "CLIENT",
        attributes: {
          ...context.attributes,
          ...namingAttributes(options.operation),
          "gen_ai.operation.name": options.operation,
          "gen_ai.memory.store.id": options.storeId,
          "agent.memory.phase": options.phase,
          "agent.memory.slot": options.slot,
          "agent.turn.id": context.identity.turnId,
        },
      };
    },
    complete(span, _data, result, context) {
      if (result.recordCount !== undefined)
        applyAttributes(span, { "gen_ai.memory.record.count": result.recordCount });
      if (context.capture.recordInputs)
        applyAttributes(span, {
          [CONTENT_FIELDS.memoryRecords]: context.serializer.json(result.records),
        });
    },
  },
};
function kind<K extends ScopeData["type"]>(data: Extract<ScopeData, { type: K }>): Kind<K> {
  return kinds[data.type] as Kind<K>;
}
export function parentKinds(data: ScopeData): readonly ScopeData["type"][] {
  return kind(data).parents;
}
export function prepareScope(
  record: Omit<ScopeRecord, "reference">,
  serializer: ContentSerializer,
): PreparedSpan {
  const context: KindContext = {
    identity: record.identity,
    attributes: identityAttributes(record.identity),
    attempt: {
      turnId: record.identity.turnId,
      index: record.attempt?.index ?? 0,
      attempt: record.attempt?.attempt ?? 0,
    },
    capture: record.capture,
    serializer,
  };
  return {
    type: record.data.type,
    operationId: record.key,
    kind: "INTERNAL",
    ...kind(record.data).prepare(record.data, context),
    parent: record.parent,
    root: record.data.type === "activation" && record.parent === undefined,
    startTimeMs: record.startTimeMs,
    links: record.links,
  };
}
export function completeScope(
  span: TraceOperation,
  data: ScopeData,
  result: ScopeTerminal,
  capture: CaptureDecision,
  startTimeMs: number,
  serializer: ContentSerializer,
): void {
  const outcome = result.outcome ?? (result.failed ? "failed" : "completed");
  // A failure is always recorded; otherwise an unknown outcome leaves the span without one.
  const known = result.outcomeUnknown !== true || result.failed === true;
  if ((data.type === "activation" || data.type === "approval") && known)
    applyAttributes(span, {
      [data.type === "activation" ? "agent.turn.outcome" : "agent.approval.outcome"]: outcome,
    });
  if (result.usage !== undefined)
    applyAttributes(
      span,
      usageAttributes(result.usage, data.type === "activation" || data.type === "model"),
    );
  kind(data).complete?.(span, data, result, { capture, startTimeMs, serializer, outcome });
  if (result.failed) span.fail(result.error, result.errorCode);
}
export function capturedScopeData(data: ScopeData, capture: CaptureDecision): ScopeData {
  if (!capture.emit) capture = { emit: false, recordInputs: false, recordOutputs: false };
  return kind(data).redact?.(data, capture) ?? data;
}
function modelResultAttributes(
  input: ModelResult,
  serializer: ContentSerializer,
  recordOutputs: boolean,
): Attributes {
  const attributes: Record<string, Attributes[string]> = {
    ...usageAttributes(input.usage, true),
    "gen_ai.response.id": input.responseId,
    "gen_ai.response.model": input.responseModelId,
    "gen_ai.response.finish_reasons": [input.finishReason],
  };
  if (!recordOutputs) return attributes;
  attributes["ai.response.finish_reason"] = input.finishReason;
  const content = input.content;
  if (content === undefined) return attributes;
  attributes["gen_ai.output.messages"] = serializer.outputMessages(content, input.finishReason);
  attributes["ai.response.reasoning"] = serializer.text(
    content
      .filter((part) => part.type === "reasoning")
      .map((part) => part.text)
      .filter((text) => text.trim().length > 0)
      .join("\n"),
  );
  attributes["ai.response.text"] = serializer.text(
    content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(""),
  );
  const calls = content
    .filter((part) => part.type === "tool-call")
    .map((part) => ({ callId: part.callId, input: part.input, toolName: part.toolName }));
  if (calls.length > 0) attributes["ai.response.tool_calls"] = serializer.json(calls);
  const results = content
    .filter((part) => part.type === "tool-result" || part.type === "tool-error")
    .map((part) =>
      part.type === "tool-result"
        ? { callId: part.callId, input: part.input, output: part.output, toolName: part.toolName }
        : {
            callId: part.callId,
            input: part.input,
            error: part.error instanceof Error ? part.error.message : part.error,
            toolName: part.toolName,
          },
    );
  if (results.length > 0) attributes["ai.response.tool_results"] = serializer.toolResults(results);
  return attributes;
}
