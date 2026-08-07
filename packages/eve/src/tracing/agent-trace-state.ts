import type { SpanContext } from "#compiled/@opentelemetry/api/index.js";

import type {
  InstrumentationParentLineage,
  InstrumentationTurnTerminalEvent,
} from "#harness/instrumentation-lifecycle.js";

export interface AgentSessionTraceState {
  readonly agentName?: string;
  readonly channelKind?: string;
  readonly context: SpanContext;
  readonly rootSessionId: string;
  readonly turnsInWindow: number;
  readonly window: number;
}

export interface AgentTurnTraceState {
  readonly context: SpanContext;
  readonly lineage?: InstrumentationParentLineage;
  readonly parentSpanId: string;
  readonly rootSessionId: string;
  readonly sequence: number;
  readonly startTimeMs: number;
  readonly terminal?: {
    readonly error?: unknown;
    readonly type: InstrumentationTurnTerminalEvent["type"];
  };
}

/** Provider-owned serializable storage for durable agent trace state. */
export interface AgentTraceStateStore {
  deleteSession(sessionId: string): void | PromiseLike<void>;
  deleteTurn(sessionId: string, turnId: string): void | PromiseLike<void>;
  getSession(
    sessionId: string,
  ): AgentSessionTraceState | undefined | PromiseLike<AgentSessionTraceState | undefined>;
  getTurn(
    sessionId: string,
    turnId: string,
  ): AgentTurnTraceState | undefined | PromiseLike<AgentTurnTraceState | undefined>;
  setSession(sessionId: string, state: AgentSessionTraceState): void | PromiseLike<void>;
  setTurn(sessionId: string, turnId: string, state: AgentTurnTraceState): void | PromiseLike<void>;
}

/** In-memory trace state used by tests and non-durable runtimes. */
export class InMemoryAgentTraceStateStore implements AgentTraceStateStore {
  readonly #sessions = new Map<string, AgentSessionTraceState>();
  readonly #turns = new Map<string, AgentTurnTraceState>();

  deleteSession(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  deleteTurn(sessionId: string, turnId: string): void {
    this.#turns.delete(turnKey(sessionId, turnId));
  }

  getSession(sessionId: string): AgentSessionTraceState | undefined {
    return this.#sessions.get(sessionId);
  }

  getTurn(sessionId: string, turnId: string): AgentTurnTraceState | undefined {
    return this.#turns.get(turnKey(sessionId, turnId));
  }

  setSession(sessionId: string, state: AgentSessionTraceState): void {
    this.#sessions.set(sessionId, state);
  }

  setTurn(sessionId: string, turnId: string, state: AgentTurnTraceState): void {
    this.#turns.set(turnKey(sessionId, turnId), state);
  }
}

function turnKey(sessionId: string, turnId: string): string {
  return `${sessionId}:${turnId}`;
}
