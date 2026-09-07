import { ContextContainer, contextStorage } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import type { AgentChildTraceDispatch } from "#tracing/agent-invocation-coordinator.js";

const AgentChildTraceKey = new ContextKey<AgentChildTraceDispatch>("eve.agentChildTrace");

/** A transport-only scope; caller context never becomes another durable input. */
export function withAgentChildTrace<T>(trace: AgentChildTraceDispatch, callback: () => T): T {
  const context = contextStorage.getStore()?.fork() ?? new ContextContainer();
  context.setVirtualContext(AgentChildTraceKey, trace);
  return contextStorage.run(context, callback);
}

export function readAgentChildTrace(): AgentChildTraceDispatch | undefined {
  return contextStorage.getStore()?.get(AgentChildTraceKey);
}
