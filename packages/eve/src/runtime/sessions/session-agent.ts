import type { AgentRoster } from "#execution/agent-sessions/roster.js";
import type { DynamicSubagentSelections } from "#execution/agent-sessions/target.js";
import type { ContextReader } from "#context/key.js";
import type { Definition } from "#definitions/definition.js";
import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { DurableCompiledArtifactsSource } from "#runtime/durable-compiled-artifacts-source.js";
import type { RuntimeAdapterRegistry } from "#runtime/channels/registry.js";
import { ROOT_RUNTIME_AGENT_NODE_ID } from "#runtime/graph.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import type { CompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import type {
  AgentReasoningDefinition,
  AgentWorkflowRetentionDefinition,
  SessionUsageLimit,
} from "#shared/agent-definition.js";
import type { WorkflowAgentMetadata } from "#tools/workflow-definition.js";

export interface SessionAgentSettings {
  readonly compaction?: {
    readonly model?: RuntimeModelReference;
    readonly thresholdPercent?: number;
  };
  readonly reasoning?: AgentReasoningDefinition;
  readonly limits?: {
    readonly sessionTimeoutMs?: number | false;
    readonly sessionUsage?: SessionUsageLimit;
  };
  readonly modelCallsPerStep?: number;
  readonly retention?: AgentWorkflowRetentionDefinition;
}

export interface BundleReference {
  readonly kind: "bundle";
  readonly source: DurableCompiledArtifactsSource;
  readonly nodeId?: string;
}

export type SessionAgentReference = BundleReference;

export interface AgentSandbox {
  readonly registry: RuntimeSandboxRegistry;
  readonly template: { readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource };
}

export interface SessionAgent {
  readonly id: string;
  readonly name?: string;
  readonly reference: SessionAgentReference;
  readonly nodeId?: string;
  readonly revision: () => Promise<string>;
  readonly definitions: () => Promise<readonly Definition[]>;
  readonly settings: SessionAgentSettings;
  readonly adapters: RuntimeAdapterRegistry;
  delegates(ctx: ContextReader): Readonly<Record<string, WorkflowAgentMetadata>>;
  roster(dynamicSelections: DynamicSubagentSelections): AgentRoster;
  sandbox(): Promise<AgentSandbox | undefined>;
  connections(): readonly ResolvedConnectionDefinition[] | undefined;
  readonly compiled?: CompiledRuntimeAgentBundle;
}

export function runtimeNodeId(agent: Pick<SessionAgent, "nodeId">): string {
  return agent.nodeId ?? ROOT_RUNTIME_AGENT_NODE_ID;
}
