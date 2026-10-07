import type { SpanContext } from "@opentelemetry/api";

import type {
  InstrumentationParentLineage,
  InstrumentationPrincipalSummary,
} from "#instrumentation/lifecycle.js";
import type { ChannelAudience } from "#shared/channel-audience.js";
import type { InstrumentationDecision } from "#shared/instrumentation-decision.js";
import type { TraceSnapshot } from "#tracing/lib/index.js";

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
  readonly agentName?: string;
  /** Recorded at the turn's terminal event; the span ends at the session transition. */
  readonly terminal?: {
    readonly outcome: "cancelled" | "completed" | "failed";
    readonly errorName?: string;
    readonly errorMessage?: string;
  };
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

/** Locates a dispatched tool call in its turn's trace tree, after the turn's own state is gone. */
export interface AgentActionTraceState {
  readonly attemptId?: string;
  readonly attemptIndex: number;
  readonly callId: string;
  readonly channelAudience?: ChannelAudience;
  readonly context: SpanContext;
  readonly parentCallId?: string;
  readonly rootSessionId?: string;
  readonly sessionId: string;
  readonly stepIndex: number;
  /** When the SDK execution finished, for dispatches that report no acceptance time. */
  readonly toolEndTimeMs?: number;
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
  checkpoint: TraceSnapshot;
}
