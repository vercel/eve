import type { AgentTurnTraceState } from "#tracing/agent-trace-state.js";
import { agentTraceIdentityAttributes } from "#tracing/agent-otel-attributes.js";
import { agentSpanNamingAttributes } from "#tracing/agent-span-naming.js";
import { agentInvocationSpanName } from "#tracing/agent-span-contract.js";
import {
  TELEMETRY_CONTEXT_ATTRIBUTES,
  TELEMETRY_CONTEXT_BYTES,
  TELEMETRY_VALUE_DEPTH,
  TELEMETRY_VALUE_NODES,
  telemetryByteLength,
  truncateTelemetryText,
} from "#tracing/telemetry-budget.js";

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
    ...agentLineageAttributes(input.turn),
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

export function agentLineageAttributes(turn: AgentTurnTraceState): Record<string, string> {
  const attributes: Record<string, string> = {
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
  const budget = { bytes: TELEMETRY_CONTEXT_BYTES, count: 0, nodes: 0, truncated: false };
  flattenContextAttribute(
    attributes,
    "ai.settings.context",
    runtimeContext,
    budget,
    new WeakSet(),
    0,
  );
  if (budget.truncated) attributes["ai.settings.context.eve.telemetry.truncated"] = true;
  return attributes;
}

interface AttributeBudget {
  bytes: number;
  count: number;
  nodes: number;
  truncated: boolean;
}

function flattenContextAttribute(
  attributes: Record<string, SpanAttributeValue>,
  key: string,
  value: unknown,
  budget: AttributeBudget,
  seen: WeakSet<object>,
  depth: number,
): void {
  budget.nodes += 1;
  if (
    depth > TELEMETRY_VALUE_DEPTH ||
    budget.nodes > TELEMETRY_VALUE_NODES ||
    budget.count >= TELEMETRY_CONTEXT_ATTRIBUTES - 1 ||
    budget.bytes < 256 ||
    key.length > 256
  ) {
    budget.truncated = true;
    return;
  }
  if (value == null) return;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const bounded =
      typeof value === "string"
        ? truncateTelemetryText(value, Math.min(4096, budget.bytes - 256))
        : value;
    budget.truncated ||= bounded !== value;
    attributes[key] = bounded;
    budget.bytes -=
      telemetryByteLength(key) + (typeof bounded === "string" ? telemetryByteLength(bounded) : 16);
    budget.count += 1;
    return;
  }
  if (Array.isArray(value)) {
    const limited = value.slice(0, 64);
    budget.truncated ||= limited.length !== value.length;
    const primitives = limited.filter(
      (entry): entry is SpanAttributePrimitive =>
        typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean",
    );
    if (primitives.length !== limited.length) return;
    if (new Set(primitives.map((entry) => typeof entry)).size !== 1) return;
    const itemBytes = Math.max(
      0,
      Math.floor(Math.min(4096, budget.bytes - 256) / Math.max(1, primitives.length)),
    );
    const bounded = primitives.map((entry) =>
      typeof entry === "string" ? truncateTelemetryText(entry, itemBytes) : entry,
    );
    budget.truncated ||= bounded.some((entry, index) => entry !== primitives[index]);
    attributes[key] = bounded;
    budget.bytes -=
      telemetryByteLength(key) +
      bounded.reduce<number>(
        (total, entry) => total + (typeof entry === "string" ? telemetryByteLength(entry) : 16),
        0,
      );
    budget.count += 1;
    return;
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      budget.truncated = true;
      return;
    }
    seen.add(value);
    for (const nestedKey in value) {
      if (!Object.hasOwn(value, nestedKey)) continue;
      if (
        budget.count >= TELEMETRY_CONTEXT_ATTRIBUTES - 1 ||
        budget.nodes >= TELEMETRY_VALUE_NODES ||
        budget.bytes < 256
      ) {
        budget.truncated = true;
        break;
      }
      flattenContextAttribute(
        attributes,
        `${key}.${nestedKey}`,
        (value as Record<string, unknown>)[nestedKey],
        budget,
        seen,
        depth + 1,
      );
    }
    seen.delete(value);
  }
}
