import { redactValue } from "./redact.js";
import type { ConversationState, TraceEvent, TraceKind } from "./types.js";

export function addTrace(
  state: ConversationState,
  kind: TraceKind,
  name: string,
  summary: string,
  detail?: unknown,
  durationMs?: number,
  code?: string,
): TraceEvent {
  const event = redactValue({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    kind,
    name,
    summary,
    detail,
    code,
    durationMs,
  });
  state.traces.push(event);
  return event;
}
