import type { SpanContext } from "#compiled/@opentelemetry/api/index.js";

import type {
  InstrumentationActionKind,
  InstrumentationActionOutcome,
  InstrumentationParentLineage,
  InstrumentationPrincipalSummary,
  InstrumentationTraceContext,
  InstrumentationTurnFailedEvent,
  InstrumentationTurnSettledEvent,
  InstrumentationUsage,
} from "#instrumentation/lifecycle.js";
import type { ChannelAudience } from "#shared/channel-audience.js";
import type { InstrumentationDecision } from "#shared/instrumentation-decision.js";

export interface AgentSessionTraceState {
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
  readonly caller?: SpanContext;
  readonly channelDelivery?: AgentTurnChannelDeliveryTraceState;
  readonly context: SpanContext;
  readonly currentPrincipal?: InstrumentationPrincipalSummary;
  readonly initiatorPrincipal?: InstrumentationPrincipalSummary;
  readonly parentLineage?: InstrumentationParentLineage;
  readonly modelUsage?: { readonly inputTokens?: number; readonly outputTokens?: number };
  readonly rootSessionId: string;
  readonly sequence: number;
  readonly startTimeMs: number;
  readonly subagentName?: string;
  readonly terminal?:
    | { readonly error: unknown; readonly type: InstrumentationTurnFailedEvent["type"] }
    | { readonly type: InstrumentationTurnSettledEvent["type"] };
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
  readonly attemptIndex: number;
  readonly callId: string;
  readonly channelAudience?: ChannelAudience;
  readonly inputAttribute?: string;
  readonly isWorkflowTool?: boolean;
  readonly kind: InstrumentationActionKind;
  readonly name: string;
  readonly parent: InstrumentationTraceContext;
  readonly rootSessionId: string;
  readonly sessionId: string;
  readonly spanId: string;
  readonly startTimeMs: number;
  readonly stepIndex: number;
  readonly turnId: string;
  readonly workflowName?: string;
}

export interface AgentInvocationTraceState extends Omit<
  AgentActionTraceState,
  "inputAttribute" | "isWorkflowTool" | "kind" | "workflowName"
> {
  readonly kind: "remote-agent-call" | "subagent-call";
  readonly parentActionCallId: string;
  readonly recordOutputs?: boolean;
  readonly terminal?: AgentActionTraceTerminalState;
}

export interface AgentActionTraceTerminalState {
  readonly acceptedAtMs?: number;
  readonly error?: unknown;
  readonly outcome: InstrumentationActionOutcome;
  readonly usage?: InstrumentationUsage;
}

/** Provider-owned serializable storage for durable agent trace state. */
export interface AgentTraceStateStore {
  deleteAction(idempotencyKey: string): void | PromiseLike<void>;
  deleteActionAnchors(sessionId: string): void | PromiseLike<void>;
  deleteActions(sessionId: string, turnId?: string): void | PromiseLike<void>;
  deleteInvocation(idempotencyKey: string): void | PromiseLike<void>;
  deleteInvocations(sessionId: string, turnId?: string): void | PromiseLike<void>;
  deleteSession(sessionId: string): void | PromiseLike<void>;
  deleteTurn(sessionId: string, turnId: string): void | PromiseLike<void>;
  findAction(
    sessionId: string,
    callId: string,
  ): AgentActionTraceState | undefined | PromiseLike<AgentActionTraceState | undefined>;
  findActionAnchor(
    sessionId: string,
    turnId: string,
    callId: string,
  ): AgentActionTraceState | undefined | PromiseLike<AgentActionTraceState | undefined>;
  findInvocations(
    sessionId?: string,
    turnId?: string,
    parentActionCallId?: string,
  ): readonly AgentInvocationTraceState[] | PromiseLike<readonly AgentInvocationTraceState[]>;
  getAction(
    idempotencyKey: string,
  ): AgentActionTraceState | undefined | PromiseLike<AgentActionTraceState | undefined>;
  getSession(
    sessionId: string,
  ): AgentSessionTraceState | undefined | PromiseLike<AgentSessionTraceState | undefined>;
  getTurn(
    sessionId: string,
    turnId: string,
  ): AgentTurnTraceState | undefined | PromiseLike<AgentTurnTraceState | undefined>;
  setAction(idempotencyKey: string, state: AgentActionTraceState): void | PromiseLike<void>;
  setActionAnchor(idempotencyKey: string, state: AgentActionTraceState): void | PromiseLike<void>;
  setInvocation(idempotencyKey: string, state: AgentInvocationTraceState): void | PromiseLike<void>;
  setSession(sessionId: string, state: AgentSessionTraceState): void | PromiseLike<void>;
  setTurn(sessionId: string, turnId: string, state: AgentTurnTraceState): void | PromiseLike<void>;
  /** Atomically updates an existing turn and does nothing after that turn is deleted. */
  updateTurn(
    sessionId: string,
    turnId: string,
    update: (state: AgentTurnTraceState) => AgentTurnTraceState,
  ): void | PromiseLike<void>;
}
