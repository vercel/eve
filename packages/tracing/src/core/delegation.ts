import { context, createContextKey } from "@opentelemetry/api";
import type { CaptureDecision, TraceReference } from "./types.js";

/** Lineage a delegating tool call passes to the agent it calls: the caller's span, run, call, and capture ceiling. */
export interface AgentHandoff {
  readonly caller: TraceReference;
  readonly conversationId: string;
  readonly parentRunId: string;
  readonly parentCallId: string;
  readonly agentName: string;
  readonly capture: CaptureDecision;
  /** Set when the handoff crossed a process boundary; the callee then starts its own trace. */
  readonly remote?: boolean;
}

const HANDOFF = createContextKey("agent.tracing.handoff");
/** Returns the handoff active in the current context, or `undefined` outside a delegated call. */
export const currentAgentHandoff = () =>
  context.active().getValue(HANDOFF) as AgentHandoff | undefined;
/** Runs `execute` with `handoff` active, so turns started inside it record the delegating call as their parent. */
export function withAgentHandoff<T>(handoff: AgentHandoff, execute: () => T): T {
  return context.with(context.active().setValue(HANDOFF, handoff), execute);
}
