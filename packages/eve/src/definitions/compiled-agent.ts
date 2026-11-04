import { compiledDelegates } from "#execution/agent-sessions/metadata.js";
import { resolveSessionUsageLimit } from "#execution/effective-agent-config.js";
import { memoryDefinition, memoryToolsDefinition } from "#memory/definition.js";
import { resolveRuntimeCompiledArtifactsVersionedCacheKey } from "#runtime/cache-key.js";
import { serializeDurableCompiledArtifactsSource } from "#runtime/durable-compiled-artifacts-source.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { SessionAgent, SessionAgentSettings } from "#runtime/sessions/session-agent.js";
import { declared, type ResolvedScheduleCollection } from "#runtime/types.js";
import { scheduleCollectionToolPrefix } from "#shared/schedule-collection-tools.js";
import { approvals } from "./approvals.js";
import { builtins } from "./builtins.js";
import { catalog } from "./catalog.js";
import { connectionDefinition, connections } from "./connections.js";
import type { Definition } from "./definition.js";
import { hookDefinition } from "./hooks.js";
import { instructionsDefinition, instructions, workspace } from "./instructions.js";
import { agentModel, loadModelDefinition, parentModel } from "./model.js";
import { skillDefinition, skills } from "./skills.js";
import { subagentDefinition } from "./subagents.js";
import { staticTools, toolDefinition, toolsDefinition } from "./tools.js";

// A compiled agent, as the session-agent port: a definition for each file its node declares,
// then eve's builtins and catalog, which see everything it declares, and the model the
// session's parent gave it. Its sandbox and connections are its node's.

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
      template: { compiledArtifactsSource: bundle.compiledArtifactsSource },
    }),
    get settings() {
      return (settings ??= compiledSettings(bundle));
    },
  };
  agents.set(bundle, agent);
  return agent;
}

/** `agent.ts`'s settings, as the port names them. */
function compiledSettings(bundle: CompiledBundle): SessionAgentSettings {
  const config = bundle.resolvedAgent.config;
  let sessionUsage: { readonly limit: ReturnType<typeof resolveSessionUsageLimit> } | undefined;
  return {
    compaction: {
      model: bundle.turnAgent.compactionModel,
      thresholdPercent: config?.compaction?.thresholdPercent,
    },
    limits: {
      sessionTimeoutMs: config?.limits?.sessionTimeoutMs,
      // Falls back to the root's, which only the graph knows: read when a turn asks for it.
      get sessionUsage() {
        return (sessionUsage ??= { limit: resolveSessionUsageLimit(bundle) }).limit;
      },
    },
    modelCallsPerStep: config?.experimental?.workflow?.modelCallsPerStep,
    reasoning: bundle.turnAgent.reasoning,
    retention: config?.experimental?.workflow?.retention,
  };
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
  const agent = bundle.resolvedAgent;
  const model = await loadModelDefinition(bundle);
  const staticModel = agentModel(bundle);
  // The order is the contract. Definitions contribute in it, and each arrangement wraps what the
  // ones before it left: the first to offer a tool name keeps it, so static tools come before
  // dynamic ones, and connections keep theirs before tools and subagents check names against them.
  // The catalog arranges after every tool, so it indexes the final table. The last model choice wins.
  return [
    ...declared(agent, "hook").map(hookDefinition),
    ...(staticModel === undefined ? [] : [staticModel]),
    ...(model === undefined ? [] : [model]),
    instructions,
    ...declared(agent, "instructions").map(instructionsDefinition),
    workspace,
    connections,
    ...declared(agent, "connection").map(connectionDefinition),
    staticTools,
    ...bundle.subagentRegistry.dynamicResolvers.map(subagentDefinition),
    ...declared(agent, "memory").map(memoryDefinition),
    ...declared(agent, "memory")
      .filter((memory) => memory.offersTools === true)
      .map(memoryToolsDefinition),
    ...declared(agent, "tool").map(toolDefinition),
    ...declared(agent, "schedules")
      .filter((collection) => collection.offersTools === true)
      .map(scheduleToolsDefinition),
    ...declared(agent, "skill").map(skillDefinition),
    skills,
    approvals,
    builtins,
    catalog,
    // Last, so a parent's choice is the one the session runs: nothing of the session's evaluates for it.
    parentModel,
  ];
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
