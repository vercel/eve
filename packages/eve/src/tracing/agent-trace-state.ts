import type { SpanContext } from "#compiled/@opentelemetry/api/index.js";

import type {
  InstrumentationActionKind,
  InstrumentationTraceContext,
  InstrumentationTurnFailedEvent,
  InstrumentationTurnSettledEvent,
} from "#instrumentation/lifecycle.js";
import type { ChannelAudience } from "#shared/channel-audience.js";
import type { InstrumentationDecision } from "#shared/instrumentation-decision.js";

export interface AgentSessionTraceState {
  readonly channelAudience?: ChannelAudience;
  readonly agentName?: string;
  readonly channelKind?: string;
  readonly context: SpanContext;
  readonly decision?: InstrumentationDecision;
  readonly rootSessionId: string;
}

export interface AgentTurnTraceState {
  readonly context: SpanContext;
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

/** Provider-owned serializable storage for durable agent trace state. */
export interface AgentTraceStateStore {
  deleteAction(idempotencyKey: string): void | PromiseLike<void>;
  deleteActions(sessionId: string, turnId?: string): void | PromiseLike<void>;
  deleteSession(sessionId: string): void | PromiseLike<void>;
  deleteTurn(sessionId: string, turnId: string): void | PromiseLike<void>;
  findAction(
    sessionId: string,
    callId: string,
  ): AgentActionTraceState | undefined | PromiseLike<AgentActionTraceState | undefined>;
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
  readonly #actions = new Map<string, AgentActionTraceState>();
  readonly #sessions = new Map<string, AgentSessionTraceState>();
  readonly #turns = new Map<string, AgentTurnTraceState>();

  deleteAction(idempotencyKey: string): void {
    this.#actions.delete(idempotencyKey);
  }

  deleteActions(sessionId: string, turnId?: string): void {
    for (const [key, state] of this.#actions) {
      if (state.sessionId === sessionId && (turnId === undefined || state.turnId === turnId)) {
        this.#actions.delete(key);
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

  getAction(idempotencyKey: string): AgentActionTraceState | undefined {
    return this.#actions.get(idempotencyKey);
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
