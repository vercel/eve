import { compiledDelegates } from "#execution/agent-sessions/metadata.js";
import { compiledAgentRoster } from "#execution/agent-sessions/roster.js";
import { resolveSessionUsageLimit } from "#execution/effective-agent-config.js";
import { memoryDefinition, memoryToolsDefinition } from "#memory/definition.js";
import { resolveRuntimeCompiledArtifactsVersionedCacheKey } from "#runtime/cache-key.js";
import { serializeDurableCompiledArtifactsSource } from "#runtime/durable-compiled-artifacts-source.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { SessionAgent, SessionAgentSettings } from "#runtime/sessions/session-agent.js";
import {
  declared,
  type ResolvedChannelDefinition,
  type ResolvedScheduleCollection,
} from "#runtime/types.js";
import { scheduleCollectionToolSlot } from "#shared/schedule-collection-tools.js";
import { type AgentContents, settingsOf } from "./agent-definitions.js";
import { createSessionAgent } from "./session-agent.js";
import { connectionDefinition } from "./connections.js";
import type { Definition } from "./definition.js";
import { hookDefinition } from "./hooks.js";
import { instructionsDefinition } from "./instructions.js";
import { agentModel, loadModelDefinition } from "./model.js";
import { skillDefinition } from "./skills.js";
import { subagentDefinition } from "./subagents.js";
import { toolDefinition, toolsDefinition } from "./tools.js";

const agents = new WeakMap<CompiledBundle, SessionAgent>();

export function fromCompiledBundle(bundle: CompiledBundle): SessionAgent {
  const known = agents.get(bundle);
  if (known !== undefined) return known;
  const agent = createSessionAgent({
    adapters: bundle.adapterRegistry,
    compiled: bundle,
    connections: () => {
      const node = bundle.graph.root.agent;
      if (node === undefined) return undefined;
      const hasDynamic = node.definitions.some(({ kind }) => kind === "connection");
      return node.connections.length === 0 && !hasDynamic ? undefined : node.connections;
    },
    contents: () => agentContentsOf(bundle),
    delegates: (ctx) => compiledDelegates(bundle, ctx),
    id: () => bundle.turnAgent.id,
    name: () => bundle.resolvedAgent.config?.name,
    nodeId: () => bundle.nodeId,
    reference: () => ({
      kind: "bundle",
      nodeId: bundle.nodeId,
      source: serializeDurableCompiledArtifactsSource(bundle.compiledArtifactsSource),
    }),
    revision: async () => {
      const deploymentId = process.env.VERCEL_DEPLOYMENT_ID?.trim();
      return deploymentId
        ? `deployment:${deploymentId}`
        : await resolveRuntimeCompiledArtifactsVersionedCacheKey(bundle.compiledArtifactsSource);
    },
    roster: (dynamicSelections) => compiledAgentRoster(bundle, dynamicSelections),
    sandbox: async () => ({
      registry: bundle.graph.root.sandboxRegistry,
      template: { compiledArtifactsSource: bundle.compiledArtifactsSource },
    }),
    settings: () => compiledSettings(bundle),
  });
  agents.set(bundle, agent);
  return agent;
}

function compiledSettings(bundle: CompiledBundle): SessionAgentSettings {
  const config = bundle.resolvedAgent.config;
  return settingsOf({
    compactionModel: bundle.turnAgent.compactionModel,
    compactionThresholdPercent: config?.compaction?.thresholdPercent,
    modelCallsPerStep: config?.experimental?.workflow?.modelCallsPerStep,
    reasoning: bundle.turnAgent.reasoning,
    retention: config?.experimental?.workflow?.retention,
    sessionTimeoutMs: config?.limits?.sessionTimeoutMs,
    sessionUsage: () => resolveSessionUsageLimit(bundle),
  });
}

export async function agentContentsOf(bundle: CompiledBundle): Promise<AgentContents> {
  const agent = bundle.resolvedAgent;
  const model = await loadModelDefinition(bundle);
  const staticModel = agentModel(bundle);
  return {
    connections: declared(agent, "connection").map(connectionDefinition),
    files: {
      dynamicSubagents: bundle.subagentRegistry.dynamicResolvers.map(subagentDefinition),
      hooks: declared(agent, "hook").map(hookDefinition),
      memory: [
        ...declared(agent, "memory").map(memoryDefinition),
        ...declared(agent, "memory")
          .filter((memory) => memory.offersTools === true)
          .map(memoryToolsDefinition),
      ],
      channelSubscriptionTools: channelSubscriptionToolsDefinitions(agent.channels),
      scheduleTools: scheduleToolsDefinitions(
        declared(agent, "schedules").filter((collection) => collection.offersTools === true),
      ),
    },
    instructions: declared(agent, "instructions").map(instructionsDefinition),
    model: [staticModel, model].filter((definition) => definition !== undefined),
    skills: declared(agent, "skill").map(skillDefinition),
    tools: declared(agent, "tool").map(toolDefinition),
  };
}

function channelSubscriptionToolsDefinitions(
  channels: readonly ResolvedChannelDefinition[],
): readonly Definition[] {
  if (!channels.some((channel) => channel.definition?.subscriptions !== undefined)) return [];
  return [
    toolsDefinition(
      { logicalPath: "tools/channel-subscriptions.ts", slug: "channel-subscriptions" },
      async () => {
        const { channelSubscriptionTools } =
          await import("#runtime/subscriptions/tools.js");
        return channelSubscriptionTools(channels);
      },
    ),
  ];
}

function scheduleToolsDefinitions(
  collections: readonly ResolvedScheduleCollection[],
): readonly Definition[] {
  const scoped = new Map<string, ResolvedScheduleCollection[]>();
  const definitions: Definition[] = [];
  for (const collection of collections) {
    const slug = scheduleCollectionToolSlot(collection);
    const source = { logicalPath: `tools/${slug}.ts`, slug };
    if (collection.namedScope === undefined) {
      definitions.push(
        toolsDefinition(source, async () => {
          const { scheduleCollectionTools } = await import("#context/schedule-collection-tools.js");
          return scheduleCollectionTools(collection.definition, collection.name);
        }),
      );
      continue;
    }
    const scopes = scoped.get(slug);
    if (scopes !== undefined) {
      scopes.push(collection);
      continue;
    }
    const opened = [collection];
    scoped.set(slug, opened);
    definitions.push(
      toolsDefinition(source, async () => {
        const { scheduleScopesTools } = await import("#context/schedule-collection-tools.js");
        return scheduleScopesTools(
          opened.map((scope) => ({
            collection: scope.name,
            definition: scope.definition,
            scope: scope.namedScope!.name,
            description: scope.namedScope!.description,
          })),
          slug,
        );
      }),
    );
  }
  return definitions;
}
