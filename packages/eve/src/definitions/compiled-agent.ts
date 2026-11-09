import { compiledDelegates } from "#execution/agent-sessions/metadata.js";
import { compiledAgentRoster } from "#execution/agent-sessions/roster.js";
import { resolveSessionUsageLimit } from "#execution/effective-agent-config.js";
import { memoryDefinition, memoryToolsDefinition } from "#memory/definition.js";
import { resolveRuntimeCompiledArtifactsVersionedCacheKey } from "#runtime/cache-key.js";
import { serializeDurableCompiledArtifactsSource } from "#runtime/durable-compiled-artifacts-source.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { SessionAgent, SessionAgentSettings } from "#runtime/sessions/session-agent.js";
import { declared, type ResolvedScheduleCollection } from "#runtime/types.js";
import { scheduleCollectionToolPrefix } from "#shared/schedule-collection-tools.js";
import { agentDefinitionsOf, type AgentContents, settingsOf } from "./agent-definitions.js";
import { connectionDefinition } from "./connections.js";
import type { Definition } from "./definition.js";
import { hookDefinition } from "./hooks.js";
import { instructionsDefinition } from "./instructions.js";
import { agentModel, loadModelDefinition } from "./model.js";
import { skillDefinition } from "./skills.js";
import { subagentDefinition } from "./subagents.js";
import { toolDefinition, toolsDefinition } from "./tools.js";

// A compiled agent, as the session-agent port: its node's files, mapped to an agent's contents
// (`agentDefinitionsOf`, which places them among eve's runtime definitions), and `agent.ts`'s
// settings. Its sandbox and connections are its node's.

const agents = new WeakMap<CompiledBundle, SessionAgent>();
const built = new WeakMap<CompiledBundle, Promise<readonly Definition[]>>();

/** A compiled node's agent, made once per bundle: its files' definitions, and `agent.ts`'s settings. */
export function fromCompiledBundle(bundle: CompiledBundle): SessionAgent {
  const known = agents.get(bundle);
  if (known !== undefined) return known;
  let settings: SessionAgentSettings | undefined;
  // Read on use: a bundle's graph and config are only reached by what asks for them.
  const agent: SessionAgent = {
    adapters: bundle.adapterRegistry,
    compiled: bundle,
    connections: () => {
      const node = bundle.graph.root.agent;
      if (node === undefined) return undefined;
      const hasDynamic = node.definitions.some(({ kind }) => kind === "connection");
      return node.connections.length === 0 && !hasDynamic ? undefined : node.connections;
    },
    definitions: () => compiledDefinitions(bundle),
    delegates: (ctx) => compiledDelegates(bundle, ctx),
    roster: (dynamicSelections) => compiledAgentRoster(bundle, dynamicSelections),
    get id() {
      return bundle.turnAgent.id;
    },
    get name() {
      return bundle.resolvedAgent.config?.name;
    },
    get nodeId() {
      return bundle.nodeId;
    },
    get reference() {
      return {
        kind: "bundle" as const,
        nodeId: bundle.nodeId,
        source: serializeDurableCompiledArtifactsSource(bundle.compiledArtifactsSource),
      };
    },
    // A deployment names its code; elsewhere the artifacts' version does.
    revision: async () => {
      const deploymentId = process.env.VERCEL_DEPLOYMENT_ID?.trim();
      return deploymentId
        ? `deployment:${deploymentId}`
        : await resolveRuntimeCompiledArtifactsVersionedCacheKey(bundle.compiledArtifactsSource);
    },
    sandbox: async () => ({
      registry: bundle.graph.root.sandboxRegistry,
      sharesParent: true,
      template: { compiledArtifactsSource: bundle.compiledArtifactsSource },
    }),
    get settings() {
      return (settings ??= compiledSettings(bundle));
    },
  };
  agents.set(bundle, agent);
  return agent;
}

/** `agent.ts`'s settings, resolved by the compiler, as `settingsOf` takes them. */
function compiledSettings(bundle: CompiledBundle): SessionAgentSettings {
  const config = bundle.resolvedAgent.config;
  return settingsOf({
    compactionModel: bundle.turnAgent.compactionModel,
    compactionThresholdPercent: config?.compaction?.thresholdPercent,
    modelCallsPerStep: config?.experimental?.workflow?.modelCallsPerStep,
    reasoning: bundle.turnAgent.reasoning,
    retention: config?.experimental?.workflow?.retention,
    sessionTimeoutMs: config?.limits?.sessionTimeoutMs,
    // Falls back to the root's, which only the graph knows.
    sessionUsage: () => resolveSessionUsageLimit(bundle),
  });
}

/** The definitions the node declares, built once per bundle. */
function compiledDefinitions(bundle: CompiledBundle): Promise<readonly Definition[]> {
  let definitions = built.get(bundle);
  if (definitions === undefined) {
    definitions = buildAgentDefinitions(bundle);
    built.set(bundle, definitions);
    definitions.catch(() => built.delete(bundle));
  }
  return definitions;
}

async function buildAgentDefinitions(bundle: CompiledBundle): Promise<readonly Definition[]> {
  return agentDefinitionsOf(await agentContentsOf(bundle));
}

/**
 * The node's files as an agent's contents: each declared file through the builder its kind goes
 * through, an extension's under its namespace. Its static tool files (eve's defaults among them)
 * reach a session through the step's tool table, eve's `staticTools`, which `agentDefinitionsOf`
 * places itself.
 */
export async function agentContentsOf(bundle: CompiledBundle): Promise<AgentContents> {
  const agent = bundle.resolvedAgent;
  const model = await loadModelDefinition(bundle);
  const staticModel = agentModel(bundle);
  return {
    connections: declared(agent, "connection").map(connectionDefinition),
    definitions: [],
    files: {
      dynamicSubagents: bundle.subagentRegistry.dynamicResolvers.map(subagentDefinition),
      hooks: declared(agent, "hook").map(hookDefinition),
      // Every memory, then the tools those that offer them do.
      memory: [
        ...declared(agent, "memory").map(memoryDefinition),
        ...declared(agent, "memory")
          .filter((memory) => memory.offersTools === true)
          .map(memoryToolsDefinition),
      ],
      scheduleTools: declared(agent, "schedules")
        .filter((collection) => collection.offersTools === true)
        .map(scheduleToolsDefinition),
    },
    instructions: declared(agent, "instructions").map(instructionsDefinition),
    model: [staticModel, model].filter((definition) => definition !== undefined),
    skills: declared(agent, "skill").map(skillDefinition),
    // Its declared subagents are tools in its tool table, eve's `staticTools`.
    subagents: [],
    tools: declared(agent, "tool").map(toolDefinition),
  };
}

/** A schedule collection's tools, as the tool file `agent/tools/schedule__<name>.ts` would offer them. */
function scheduleToolsDefinition(collection: ResolvedScheduleCollection): Definition {
  const slug = scheduleCollectionToolPrefix(collection.name);
  return toolsDefinition({ logicalPath: `tools/${slug}.ts`, slug }, async () => {
    // Loaded where it runs: the schedule client reaches Workflow, which the harness doesn't.
    const { scheduleCollectionTools } = await import("#context/schedule-collection-tools.js");
    return scheduleCollectionTools(collection.definition, collection.name);
  });
}
