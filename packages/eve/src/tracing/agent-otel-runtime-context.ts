import type { AgentTurnTraceState } from "#tracing/agent-trace-state.js";

type SpanAttributePrimitive = string | number | boolean;
type SpanAttributeValue = SpanAttributePrimitive | SpanAttributePrimitive[];

export function agentLineageAttributes(
  turn: AgentTurnTraceState,
): Record<string, SpanAttributeValue> {
  const attributes: Record<string, SpanAttributeValue> = {
    "agent.root_run.id": turn.rootSessionId,
  };
  if (turn.parentLineage !== undefined) {
    attributes["agent.parent_run.id"] = turn.parentLineage.sessionId;
    attributes["agent.parent_call.id"] = turn.parentLineage.callId;
  }
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
