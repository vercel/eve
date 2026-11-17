import { ContextContainer, contextStorage } from "#context/container.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import type { AgentSettings } from "#execution/effective-agent-config.js";
import { createKernel } from "#harness/kernel.js";
import { foldPublication } from "#harness/session-machine/current.js";
import type { KernelConfig, StepFn, StepResult } from "#harness/types.js";
import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";
import { ConnectionRegistryImpl } from "#runtime/connections/registry.js";
import { fromCompiledBundle } from "#definitions/compiled-agent.js";
import { SessionAgentKey } from "#runtime/sessions/runtime-context-keys.js";
import type { SessionAgent } from "#runtime/sessions/session-agent.js";

export interface TestKernelConfig extends KernelConfig {
  readonly agent: { readonly model: RuntimeModelReference } & AgentSettings;
}

export function createTestKernel({ agent, ...config }: TestKernelConfig): StepFn {
  const step = createKernel(config);
  const run: StepFn = async (session, input) => {
    const ctx = contextStorage.getStore();
    if (ctx !== undefined) {
      if (!ctx.has(SessionAgentKey)) ctx.set(SessionAgentKey, testAgent(agent));
      if (!ctx.has(ConnectionRegistryKey)) {
        ctx.set(ConnectionRegistryKey, new ConnectionRegistryImpl([]));
      }
      return continued(await step(session, input));
    }
    const own = new ContextContainer();
    own.set(SessionAgentKey, testAgent(agent));
    own.set(ConnectionRegistryKey, new ConnectionRegistryImpl([]));
    const folding = createKernel({
      ...config,
      handleEvent: async (publication, messages) => {
        foldPublication(own, publication);
        await config.handleEvent?.(publication, messages);
      },
    });
    return continued(await contextStorage.run(own, () => folding(session, input)));
  };
  const continued = (result: StepResult): StepResult =>
    typeof result.next === "function" ? { ...result, next: run } : result;
  return run;
}

function testAgent(agent: TestKernelConfig["agent"]): SessionAgent {
  return fromCompiledBundle({
    graph: { nodesByNodeId: new Map() },
    modelMetadata: async () => ({}),
    nodeId: "root",
    resolvedAgent: {
      config: { compaction: { thresholdPercent: agent.thresholdPercent } },
      definitions: [],
      instructions: [],
      skills: [],
    },
    subagentRegistry: { dynamicResolvers: [], preparedTools: [], subagentsByName: new Map() },
    toolRegistry: { toolsByName: new Map() },
    turnAgent: {
      compactionModel: agent.compactionModel,
      id: "agent",
      model: agent.model,
      reasoning: agent.reasoning,
    },
  } as never);
}
