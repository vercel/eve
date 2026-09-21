import { ContextKey } from "#context/key.js";
import type { AgentRegistry } from "#subagents/registry/registry.js";

export const AgentRegistryKey = new ContextKey<AgentRegistry>("eve.internal.agentRegistry");
