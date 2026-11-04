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

// The agent a session runs, as a port: what the session loop, its steps and its tools ask of
// an agent, whatever produced it. Its implementation is a compiled bundle's
// (`#definitions/compiled-agent.js`). A step boundary carries only its `reference`.

/** What an agent sets for its sessions, beside its definitions. */
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
  /** Model calls per durable step; `1` when omitted. */
  readonly modelCallsPerStep?: number;
  /** Workflow's `experimental.workflow.retention`. */
  readonly retention?: AgentWorkflowRetentionDefinition;
}

/** A compiled agent, by its artifacts and node: any process with the artifacts loads it. */
export interface BundleReference {
  readonly kind: "bundle";
  readonly source: DurableCompiledArtifactsSource;
  readonly nodeId?: string;
}

/** How a step boundary carries a session's agent. */
export type SessionAgentReference = BundleReference;

/** What opens an agent's sandbox: the fields `ensureSandboxAccess` takes about the agent. */
export interface AgentSandbox {
  readonly registry: RuntimeSandboxRegistry;
  /** Where its template comes from: a build's artifacts. */
  readonly template: { readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource };
}

/** The agent a session runs. */
export interface SessionAgent {
  /** The agent's id, as events and traces name it (`agentId`). */
  readonly id: string;
  /** The agent's display name (`agentName`), when it has one. */
  readonly name?: string;
  /** How a step boundary carries it. */
  readonly reference: SessionAgentReference;
  /**
   * Its node in the agent graph its sessions run in, `undefined` at the root. Events, Workflow
   * attributes, sandboxes and memory namespaces name the agent by it.
   */
  readonly nodeId?: string;
  /**
   * Names this generation of the agent's code. Kept values recorded under another revision are
   * evaluated again, so a change to what a definition does must change it.
   */
  readonly revision: () => Promise<string>;
  readonly definitions: () => Promise<readonly Definition[]>;
  readonly settings: SessionAgentSettings;
  /** The channel adapters a session's channel rehydrates from at each step. */
  readonly adapters: RuntimeAdapterRegistry;
  /** The agents a workflow tool's `ctx.agents` lists in the session `ctx` belongs to. */
  delegates(ctx: ContextReader): Readonly<Record<string, WorkflowAgentMetadata>>;
  /** What opens its sessions' sandbox, when it has one. */
  sandbox(): Promise<AgentSandbox | undefined>;
  /**
   * The connections its sessions start with, which dynamic connections join. `undefined`: none,
   * and nothing that adds one, so its sessions get no registry.
   */
  connections(): readonly ResolvedConnectionDefinition[] | undefined;
  /**
   * What only an agent compiled from files has: its node of the compiled graph, with the module
   * map, manifest-derived registries and artifacts its files' features read.
   */
  readonly compiled?: CompiledRuntimeAgentBundle;
}

/** `agent`'s node, the root's id included: what a host names a session's agent node by. */
export function runtimeNodeId(agent: Pick<SessionAgent, "nodeId">): string {
  return agent.nodeId ?? ROOT_RUNTIME_AGENT_NODE_ID;
}
