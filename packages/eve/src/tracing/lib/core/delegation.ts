import { context, createContextKey } from "@opentelemetry/api";
import type { CaptureDecision, TraceReference } from "./types.js";

export interface AgentHandoff {
  readonly caller: TraceReference;
  readonly conversationId: string;
  readonly parentRunId: string;
  readonly parentCallId: string;
  readonly agentName: string;
  readonly capture: CaptureDecision;
}

const HANDOFF = createContextKey("agent.tracing.handoff");
export const currentAgentHandoff = () =>
  context.active().getValue(HANDOFF) as AgentHandoff | undefined;
export function withAgentHandoff<T>(handoff: AgentHandoff, execute: () => T): T {
  return context.with(context.active().setValue(HANDOFF, handoff), execute);
}
