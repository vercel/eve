import type { ContextReader } from "#context/key.js";
import type { Definition } from "#definitions/definition.js";
import type { AgentRoster } from "#execution/agent-sessions/roster.js";
import type { DynamicSubagentSelections } from "#execution/agent-sessions/target.js";
import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { DurableCompiledArtifactsSource } from "#runtime/durable-compiled-artifacts-source.js";
import type { RuntimeAdapterRegistry } from "#runtime/channels/registry.js";
import { ROOT_RUNTIME_AGENT_NODE_ID } from "#runtime/graph.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import type { CompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import type { SandboxPreparedArtifact } from "#shared/sandbox-provider.js";
import type {
  AgentReasoningDefinition,
  AgentWorkflowRetentionDefinition,
  SessionUsageLimit,
} from "#shared/agent-definition.js";
import type { WorkflowAgentMetadata } from "#tools/workflow-definition.js";

// The agent a session runs, as a port: what the session loop, its steps and its tools ask of
// an agent, whatever produced it. Its implementation is a compiled bundle's
// (`#definitions/compiled-agent.js`); an agent a process holds instead, rather than one it loads
// from compiled artifacts, is named by a `HeldReference`. A step boundary carries only its
// `reference`.

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

/** An agent held by this process only, not compiled from files: its sessions run where it is held. */
export interface HeldReference {
  readonly kind: "runtime";
  readonly id: string;
}

/** How a step boundary carries a session's agent. */
export type SessionAgentReference = BundleReference | HeldReference;

/** What opens an agent's sandbox: the fields `ensureSandboxAccess` takes about the agent. */
export interface AgentSandbox {
  readonly registry: RuntimeSandboxRegistry;
  /** Where its template comes from: a build's artifacts, or prepared on first use. */
  readonly template:
    | { readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource }
    | {
        readonly appRoot: string;
        readonly preparedArtifact: () => Promise<SandboxPreparedArtifact>;
      };
  /**
   * Whether a child session runs in the sandbox its parent recorded on the child's channel. A
   * compiled node shares when its graph says so; an agent defined in code owns its sandbox.
   */
  readonly sharesParent: boolean;
}

/** The agent a session runs. */
export interface SessionAgent {
  /** The agent's id, as events and traces name it (`agentId`). */
  readonly id: string;
  /** The agent's display name (`agentName`), when it has one. */
  readonly name?: string;
  /** What the agent is for, as a parent's model reads it when it can delegate to the agent. */
  readonly description?: string;
  /** How a step boundary carries it. */
  readonly reference: SessionAgentReference;
  /**
   * Its node in the agent graph its sessions run in: a subagent's (`subagents/<name>` for one
   * defined in code, the compiled node id for one from files), `undefined` at the root. Events,
   * Workflow attributes, sandboxes and memory namespaces name the agent by it.
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
  /** The agents its sessions delegate to, with the dynamic ones the calling turn selected. */
  roster(dynamicSelections: DynamicSubagentSelections): AgentRoster;
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

/** An agent another delegates to, under the name its tool and `ctx.agent(name)` use. */
export interface SessionSubagent {
  readonly name: string;
  /** What the parent's model reads about it. */
  readonly description: string;
  readonly agent: CodeAgent;
}

/** An agent defined in code: the port, and what only a program's agent declares. */
export interface CodeAgent extends SessionAgent {
  readonly reference: HeldReference;
  /** The agents it delegates to, by name, each under the id `<id>/<name>`. */
  readonly subagents: ReadonlyMap<string, SessionSubagent>;
  /** The same agent's code under another id and node, as a parent scopes its subagents. */
  with(identity: { readonly id: string; readonly nodeId: string }): CodeAgent;
}

/** `agent`'s node, the root's id included: what a host names a session's agent node by. */
export function runtimeNodeId(agent: Pick<SessionAgent, "nodeId">): string {
  return agent.nodeId ?? ROOT_RUNTIME_AGENT_NODE_ID;
}

// Agents this process holds, by id, rooted on `globalThis` as the runtime session store is: a
// Workflow step can load its own copy of eve's modules, and must still find what the app held.
interface HeldAgent {
  readonly agent: CodeAgent;
  count: number;
}

const HELD_AGENTS_GLOBAL_KEY = Symbol.for("eve.held-session-agents");
const held = ((globalThis as { [HELD_AGENTS_GLOBAL_KEY]?: Map<string, HeldAgent> })[
  HELD_AGENTS_GLOBAL_KEY
] ??= new Map());

/**
 * Holds `agent` and its subagents, at every depth, in this process so a step can resolve each by
 * id, until every hold of it is released. A later agent under the same id replaces it, as a
 * program that builds its agent again does.
 */
export function holdSessionAgent(agent: CodeAgent): () => void {
  let hold = held.get(agent.id);
  if (hold?.agent !== agent) {
    hold = { agent, count: 0 };
    held.set(agent.id, hold);
  }
  const thisHold = hold;
  thisHold.count += 1;
  const releases = [...agent.subagents.values()].map((sub) => holdSessionAgent(sub.agent));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const release of releases) release();
    thisHold.count -= 1;
    if (thisHold.count === 0 && held.get(agent.id) === thisHold) held.delete(agent.id);
  };
}

/** The agent this process holds under `id`. */
export function resolveHeldSessionAgent(id: string): CodeAgent {
  const agent = held.get(id)?.agent;
  if (agent === undefined) {
    throw new Error(
      `No agent "${id}" is held in this process. A session of an agent defined in code runs only where that code runs: hold it (createSession or holdSessionAgent) before the session's steps do.`,
    );
  }
  return agent;
}
