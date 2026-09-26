import type {
  AgentActionTraceState,
  AgentInvocationTraceState,
  AgentSessionTraceState,
  AgentTraceStateStore,
  AgentTurnTraceState,
} from "#tracing/agent-trace-state.js";

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
    sessionId?: string,
    turnId?: string,
    parentActionCallId?: string,
  ): readonly AgentInvocationTraceState[] {
    return [...this.#invocations.values()].filter(
      (state) =>
        (sessionId === undefined || state.sessionId === sessionId) &&
        (turnId === undefined || state.turnId === turnId) &&
        (parentActionCallId === undefined || state.parentActionCallId === parentActionCallId),
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

function turnKey(sessionId: string, turnId: string): string {
  return `${sessionId}:${turnId}`;
}
