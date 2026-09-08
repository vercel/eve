import type { AgentTurnTraceState } from "#tracing/agent-trace-state.js";
import { agentTraceIdentityAttributes } from "#tracing/agent-otel-attributes.js";
import { agentSpanNamingAttributes } from "#tracing/agent-span-naming.js";
import { agentInvocationSpanName } from "#tracing/agent-span-contract.js";

type SpanAttributePrimitive = string | number | boolean;
type SpanAttributeValue = SpanAttributePrimitive | SpanAttributePrimitive[];

export function agentActivationAttributes(input: {
  readonly agentName?: string;
  readonly frameworkVersion: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly turn: AgentTurnTraceState;
}): Record<string, string | number | boolean | undefined> {
  return {
    "agent.framework.name": "eve",
    "agent.framework.version": input.frameworkVersion,
    "agent.name": input.agentName,
    "agent.subagent.name": input.turn.subagentName,
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
