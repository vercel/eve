import type { AgentTraceStateStore, AgentTraceValues } from "#tracing/eve/agent-trace-state.js";

export class InMemoryAgentTraceStateStore implements AgentTraceStateStore {
  readonly #entries = new Map<string, AgentTraceValues[keyof AgentTraceValues]>();
  get<K extends keyof AgentTraceValues>(kind: K, key: string): AgentTraceValues[K] | undefined {
    return this.#entries.get(JSON.stringify([kind, key])) as AgentTraceValues[K] | undefined;
  }
  set<K extends keyof AgentTraceValues>(kind: K, key: string, value: AgentTraceValues[K]): void {
    this.#entries.set(JSON.stringify([kind, key]), value);
  }
  delete(kind: keyof AgentTraceValues, key: string): void {
    this.#entries.delete(JSON.stringify([kind, key]));
  }
  update<K extends keyof AgentTraceValues>(
    kind: K,
    key: string,
    update: (value: AgentTraceValues[K]) => AgentTraceValues[K],
  ): void {
    const value = this.get(kind, key);
    if (value !== undefined) this.set(kind, key, update(value));
  }
  entries<K extends keyof AgentTraceValues>(kind: K): [string, AgentTraceValues[K]][] {
    return [...this.#entries].flatMap(([key, value]) => {
      const [storedKind, id] = JSON.parse(key);
      return storedKind === kind
        ? [[id, value as AgentTraceValues[K]] as [string, AgentTraceValues[K]]]
        : [];
    });
  }
}
