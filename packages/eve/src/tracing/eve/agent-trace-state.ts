import type { SpanContext } from "@opentelemetry/api";

import type {
  InstrumentationParentLineage,
  InstrumentationPrincipalSummary,
} from "#instrumentation/lifecycle.js";
import type { ChannelAudience } from "#shared/channel-audience.js";
import type { InstrumentationDecision } from "#shared/instrumentation-decision.js";

export interface AgentSessionTraceState {
  readonly traceSessionId: string;
  readonly channelAudience?: ChannelAudience;
  readonly agentName?: string;
  readonly channelKind?: string;
  readonly channelType?: string;
  readonly context: SpanContext;
  readonly decision?: InstrumentationDecision;
  readonly parentLineage?: InstrumentationParentLineage;
  readonly rootSessionId: string;
  readonly scheduleId?: string;
  readonly title?: string;
}

export interface AgentTurnTraceState {
  readonly snapshot?: unknown;
  readonly traceSessionId: string;
  readonly caller?: SpanContext;
  readonly channelDelivery?: AgentTurnChannelDeliveryTraceState;
  readonly context: SpanContext;
  readonly currentPrincipal?: InstrumentationPrincipalSummary;
  readonly initiatorPrincipal?: InstrumentationPrincipalSummary;
  readonly parentLineage?: InstrumentationParentLineage;
  readonly rootSessionId: string;
  readonly sequence: number;
  readonly startTimeMs: number;
  readonly subagentName?: string;
}

export interface AgentTurnChannelDeliveryTraceState {
  readonly channelKind: string;
  readonly channelName: string;
  readonly deliveryId: string;
  readonly inputAttribute?: string;
  readonly requestId?: string;
  readonly requestTraceContext?: SpanContext;
}

export interface AgentActionTraceState {
  readonly attemptId?: string;
  readonly snapshot?: unknown;
  readonly callId: string;
  readonly channelAudience?: ChannelAudience;
  readonly sessionId: string;
  readonly turnId: string;
}

/** Provider-owned serializable storage for durable agent trace state. */
export interface AgentTraceStateStore {
  get<K extends keyof AgentTraceValues>(
    kind: K,
    key: string,
  ): AgentTraceValues[K] | undefined | PromiseLike<AgentTraceValues[K] | undefined>;
  set<K extends keyof AgentTraceValues>(
    kind: K,
    key: string,
    value: AgentTraceValues[K],
  ): void | PromiseLike<void>;
  delete(kind: keyof AgentTraceValues, key: string): void | PromiseLike<void>;
  update<K extends keyof AgentTraceValues>(
    kind: K,
    key: string,
    update: (value: AgentTraceValues[K]) => AgentTraceValues[K],
  ): void | PromiseLike<void>;
  entries<K extends keyof AgentTraceValues>(
    kind: K,
  ):
    | readonly [string, AgentTraceValues[K]][]
    | PromiseLike<readonly [string, AgentTraceValues[K]][]>;
}
export interface AgentTraceValues {
  session: AgentSessionTraceState;
  turn: AgentTurnTraceState;
  action: AgentActionTraceState;
  anchor: AgentActionTraceState;
}
