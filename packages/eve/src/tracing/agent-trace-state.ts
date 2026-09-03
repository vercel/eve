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
  readonly context: SpanContext;
  readonly decision?: InstrumentationDecision;
  readonly parentLineage?: InstrumentationParentLineage;
  readonly rootSessionId: string;
}

export interface AgentTurnTraceState {
  readonly context: SpanContext;
  readonly currentPrincipal?: InstrumentationPrincipalSummary;
  readonly initiatorPrincipal?: InstrumentationPrincipalSummary;
  readonly parentLineage?: InstrumentationParentLineage;
  readonly modelUsage?: { readonly inputTokens?: number; readonly outputTokens?: number };
  readonly parentIsRemote?: boolean;
  readonly parentSpanId: string;
  readonly rootSessionId: string;
  readonly sequence: number;
  readonly startTimeMs: number;
  readonly subagentName?: string;
  readonly terminal?:
    | { readonly error: unknown; readonly type: InstrumentationTurnFailedEvent["type"] }
    | { readonly type: InstrumentationTurnSettledEvent["type"] };
}

export interface AgentActionTraceState {
  readonly attemptIndex: number;
  readonly callId: string;
  readonly channelAudience?: ChannelAudience;
  readonly childTraceId?: string;
  readonly inputAttribute?: string;
  readonly kind: InstrumentationActionKind;
  readonly name: string;
  readonly parent: InstrumentationTraceContext;
  readonly rootSessionId: string;
  readonly sessionId: string;
  readonly spanId: string;
  readonly startTimeMs: number;
  readonly stepIndex: number;
  readonly turnId: string;
}

export interface AgentInvocationTraceState extends Omit<
  AgentActionTraceState,
  "childTraceId" | "inputAttribute" | "kind"
> {
  readonly childTraceId?: string;
  readonly kind: "remote-agent-call" | "subagent-call";
  readonly parentActionCallId: string;
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
    sessionId: string,
    turnId?: string,
    parentActionCallId?: string,
  ): readonly AgentInvocationTraceState[] | PromiseLike<readonly AgentInvocationTraceState[]>;
  getAction(
    idempotencyKey: string,
  ): AgentActionTraceState | undefined | PromiseLike<AgentActionTraceState | undefined>;
  getInvocation(
    idempotencyKey: string,
  ): AgentInvocationTraceState | undefined | PromiseLike<AgentInvocationTraceState | undefined>;
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

/** In-memory trace state used by tests and non-durable runtimes. */
export class InMemoryAgentTraceStateStore implements AgentTraceStateStore {
  readonly #actionAnchors = new Map<string, AgentActionTraceState>();
  readonly #actions = new Map<string, AgentActionTraceState>();
  readonly #invocations = new Map<string, AgentInvocationTraceState>();
  readonly #sessions = new Map<string, AgentSessionTraceState>();
  readonly #turns = new Map<string, AgentTurnTraceState>();

  deleteAction(idempotencyKey: string): void {
    this.#actions.delete(idempotencyKey);
  }

  deleteActionAnchors(sessionId: string): void {
    for (const [key, state] of this.#actionAnchors) {
      if (state.sessionId === sessionId) this.#actionAnchors.delete(key);
    }
  }

  deleteActions(sessionId: string, turnId?: string): void {
    for (const [key, state] of this.#actions) {
      if (state.sessionId === sessionId && (turnId === undefined || state.turnId === turnId)) {
        this.#actions.delete(key);
      }
    }
  }

  deleteInvocation(idempotencyKey: string): void {
    this.#invocations.delete(idempotencyKey);
  }

  deleteInvocations(sessionId: string, turnId?: string): void {
    for (const [key, state] of this.#invocations) {
      if (state.sessionId === sessionId && (turnId === undefined || state.turnId === turnId)) {
        this.#invocations.delete(key);
      }
    }
  }

  deleteSession(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  deleteTurn(sessionId: string, turnId: string): void {
    this.#turns.delete(turnKey(sessionId, turnId));
  }

  findAction(sessionId: string, callId: string): AgentActionTraceState | undefined {
    return [...this.#actions.values()].find(
      (state) => state.sessionId === sessionId && state.callId === callId,
    );
  }

  findActionAnchor(
    sessionId: string,
    turnId: string,
    callId: string,
  ): AgentActionTraceState | undefined {
    return [...this.#actionAnchors.values()].find(
      (state) =>
        state.sessionId === sessionId && state.turnId === turnId && state.callId === callId,
    );
  }

  findInvocations(
    sessionId: string,
    turnId?: string,
    parentActionCallId?: string,
  ): readonly AgentInvocationTraceState[] {
    return [...this.#invocations.values()].filter(
      (state) =>
        state.sessionId === sessionId &&
        (turnId === undefined || state.turnId === turnId) &&
        (parentActionCallId === undefined || state.parentActionCallId === parentActionCallId),
    );
  }

  getAction(idempotencyKey: string): AgentActionTraceState | undefined {
    return this.#actions.get(idempotencyKey);
  }

  getInvocation(idempotencyKey: string): AgentInvocationTraceState | undefined {
    return this.#invocations.get(idempotencyKey);
  }

  getSession(sessionId: string): AgentSessionTraceState | undefined {
    return this.#sessions.get(sessionId);
  }

  getTurn(sessionId: string, turnId: string): AgentTurnTraceState | undefined {
    return this.#turns.get(turnKey(sessionId, turnId));
  }

  setAction(idempotencyKey: string, state: AgentActionTraceState): void {
    this.#actions.set(idempotencyKey, state);
  }

  setActionAnchor(idempotencyKey: string, state: AgentActionTraceState): void {
    this.#actionAnchors.set(idempotencyKey, state);
  }

  setInvocation(idempotencyKey: string, state: AgentInvocationTraceState): void {
    this.#invocations.set(idempotencyKey, state);
  }

  setSession(sessionId: string, state: AgentSessionTraceState): void {
    this.#sessions.set(sessionId, state);
  }

  setTurn(sessionId: string, turnId: string, state: AgentTurnTraceState): void {
    this.#turns.set(turnKey(sessionId, turnId), state);
  }

  updateTurn(
    sessionId: string,
    turnId: string,
    update: (state: AgentTurnTraceState) => AgentTurnTraceState,
  ): void {
    const key = turnKey(sessionId, turnId);
    const state = this.#turns.get(key);
    if (state !== undefined) this.#turns.set(key, update(state));
  }
}

export function turnKey(sessionId: string, turnId: string): string {
  return `${sessionId}:${turnId}`;
}
