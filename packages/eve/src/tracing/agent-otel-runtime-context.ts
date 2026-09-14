import type { AgentSessionTraceState, AgentTurnTraceState } from "#tracing/agent-trace-state.js";
import { agentSpanNamingAttributes } from "#tracing/agent-span-naming.js";
import { agentInvocationSpanName } from "#tracing/agent-span-contract.js";
import { agentTraceIdentityAttributes } from "#tracing/agent-otel-attributes.js";

type SpanAttributePrimitive = string | number | boolean;
type SpanAttributeValue = SpanAttributePrimitive | SpanAttributePrimitive[];

export function agentActivationAttributes(input: {
  readonly agentName?: string;
  readonly frameworkVersion: string;
  readonly session?: AgentSessionTraceState;
  readonly sessionId: string;
  readonly turnId: string;
  readonly turn: AgentTurnTraceState;
}): Record<string, string | number | boolean | undefined> {
  const recordsTrace = input.session?.decision?.action === "record";
  const recordsInputs = recordsTrace && input.session?.decision?.recordInputs === true;
  const recordsOutputs = recordsTrace && input.session?.decision?.recordOutputs === true;
  const parentLineage = input.turn.parentLineage ?? input.session?.parentLineage;
  const isSubagent = parentLineage !== undefined;
  const channelKind = input.turn.channelDelivery?.channelKind ?? input.session?.channelKind;
  const scheduleId = isSubagent ? undefined : input.session?.scheduleId;
  const origin =
    isSubagent || channelKind === undefined
      ? undefined
      : scheduleId !== undefined
        ? "schedule"
        : "channel";
  return {
    "agent.framework.name": "eve",
    "agent.framework.version": input.frameworkVersion,
    "agent.name": input.agentName,
    "agent.channel.audience": input.session?.channelAudience,
    ...agentPrincipalAttributes(input.turn),
    "agent.channel.delivery.id": input.turn.channelDelivery?.deliveryId,
    "agent.channel.delivery.input": input.turn.channelDelivery?.inputAttribute,
    "agent.channel.kind": channelKind,
    "agent.channel.name": input.turn.channelDelivery?.channelName,
    "agent.channel.request.id": input.turn.channelDelivery?.requestId,
    "agent.parent_call.id": parentLineage?.callId,
    "agent.parent_run.id": parentLineage?.sessionId,
    "agent.run.type": isSubagent ? "subagent" : "session",
    "agent.schedule.id": scheduleId,
    "agent.session.origin": origin,
    "agent.session.title": !isSubagent && recordsInputs ? input.session?.title : undefined,
    "agent.subagent.name": input.turn.subagentName,
    "agent.trace.content.input": recordsInputs,
    "agent.trace.content.output": recordsOutputs,
    "agent.turn.id": input.turnId,
    "agent.turn.sequence": input.turn.sequence,
    "gen_ai.agent.name": input.agentName,
    "gen_ai.operation.name": "invoke_agent",
    ...agentSpanNamingAttributes(agentInvocationSpanName(input.agentName), "invoke_agent"),
    ...agentTraceIdentityAttributes({
      rootSessionId: input.turn.rootSessionId,
      sessionId: input.sessionId,
    }),
  };
}

export function agentPrincipalAttributes(turn: AgentTurnTraceState): Record<string, string> {
  const attributes: Record<string, string> = {};
  setOptionalAttribute(attributes, "agent.principal.current.id", turn.currentPrincipal?.id);
  setOptionalAttribute(attributes, "agent.principal.current.type", turn.currentPrincipal?.type);
  setOptionalAttribute(attributes, "agent.principal.initiator.id", turn.initiatorPrincipal?.id);
  setOptionalAttribute(attributes, "agent.principal.initiator.type", turn.initiatorPrincipal?.type);
  return attributes;
}

/** Flattens merged runtime context into AI SDK-compatible span attributes. */
export function runtimeContextAttributes(
  runtimeContext: Readonly<Record<string, unknown>> | undefined,
): Record<string, SpanAttributeValue> {
  const attributes: Record<string, SpanAttributeValue> = {};
  if (runtimeContext === undefined) return attributes;
  for (const [key, value] of Object.entries(runtimeContext)) {
    flattenContextAttribute(attributes, `ai.settings.context.${key}`, value);
  }
  return attributes;
}

function flattenContextAttribute(
  attributes: Record<string, SpanAttributeValue>,
  key: string,
  value: unknown,
): void {
  if (value == null) return;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    attributes[key] = value;
    return;
  }
  if (Array.isArray(value)) {
    const primitives = value.filter(
      (entry): entry is SpanAttributePrimitive =>
        typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean",
    );
    if (primitives.length !== value.length) return;
    if (new Set(primitives.map((entry) => typeof entry)).size !== 1) return;
    attributes[key] = primitives;
    return;
  }
  if (typeof value === "object") {
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      flattenContextAttribute(attributes, `${key}.${nestedKey}`, nestedValue);
    }
  }
}

function setOptionalAttribute(
  attributes: Record<string, string>,
  key: string,
  value: string | undefined,
): void {
  if (value !== undefined) attributes[key] = value;
}
