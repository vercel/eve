import type { Span } from "#compiled/@opentelemetry/api/index.js";

import type {
  InstrumentationMemoryOperation,
  InstrumentationMemoryOperationTerminalEvent,
  InstrumentationMemoryRecord,
} from "#instrumentation/lifecycle.js";
import { genAiMemoryRecordsAttribute } from "#tracing/agent-otel-content.js";
import { recordAgentSpanError } from "#tracing/agent-span-error.js";
import { agentTraceIdentityAttributes } from "#tracing/agent-otel-attributes.js";
import { agentSpanNamingAttributes } from "#tracing/agent-span-naming.js";

/** Attributes shared by eve's managed and legacy GenAI memory spans. */
export function memorySpanAttributes(
  event: InstrumentationMemoryOperation,
  frameworkVersion: string,
): Record<string, string | number> {
  const attributes: Record<string, string | number> = {
    "agent.framework.name": "eve",
    "agent.framework.version": frameworkVersion,
    "agent.memory.phase": event.phase,
    "agent.memory.slot": event.slot,
    "agent.session.id": event.sessionId,
    "gen_ai.memory.store.id": event.storeId,
    "gen_ai.operation.name": event.operationName,
    ...agentSpanNamingAttributes(event.operationName, event.operationName),
    ...agentTraceIdentityAttributes({
      rootSessionId: event.rootSessionId,
      sessionId: event.sessionId,
    }),
  };
  if (event.turnId !== undefined) attributes["agent.turn.id"] = event.turnId;
  if (event.recordCount !== undefined) {
    attributes["gen_ai.memory.record.count"] = event.recordCount;
  }
  if (event.recordId !== undefined) attributes["gen_ai.memory.record.id"] = event.recordId;
  return attributes;
}

export function setMemorySpanInputRecords(
  span: Span,
  records: readonly InstrumentationMemoryRecord[] | undefined,
): void {
  if (records === undefined) return;
  const attribute = genAiMemoryRecordsAttribute(records);
  if (attribute !== undefined) span.setAttribute("gen_ai.memory.records", attribute);
}

export function updateMemorySpan(
  span: Span,
  event: InstrumentationMemoryOperationTerminalEvent,
): void {
  if (event.recordCount !== undefined) {
    span.setAttribute("gen_ai.memory.record.count", event.recordCount);
  }
  if (event.recordId !== undefined) {
    span.setAttribute("gen_ai.memory.record.id", event.recordId);
  }
  if (event.type === "memory.operation.failed") {
    recordAgentSpanError(span, event.error);
  } else {
    const records = genAiMemoryRecordsAttribute(event.outputRecords ?? []);
    if (records !== undefined && event.outputRecords !== undefined) {
      span.setAttribute("gen_ai.memory.records", records);
    }
  }
}
