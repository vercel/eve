import type { FrameworkContextProvider } from "#context/provider.js";
import { AgentRegistryKey } from "#context/agent-registry-key.js";
import { AgentRegistry } from "#subagents/registry/registry.js";

export const agentRegistryProvider: FrameworkContextProvider<AgentRegistry> = {
  key: AgentRegistryKey,
  create(ctx, session) {
    const value = new AgentRegistry(ctx, session);
    value.initialize();
    return { value };
  },
  commit(value, session) {
    return value.commit(session);
  },
};
