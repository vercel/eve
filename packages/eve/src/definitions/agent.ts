import type { ContextReader } from "#context/key.js";
import { memoryDefinition, memoryToolsDefinition } from "#memory/definition.js";
import { BundleKey, type CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import { declared } from "#runtime/types.js";
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
import { scheduleCollectionToolPrefix } from "#shared/schedule-collection-tools.js";
import type { ResolvedScheduleCollection } from "#runtime/types.js";

const built = new WeakMap<CompiledBundle, Promise<readonly Definition[]>>();

export function agentDefinitions(bundle: CompiledBundle): Promise<readonly Definition[]> {
  let definitions = built.get(bundle);
  if (definitions === undefined) {
    definitions = buildAgentDefinitions(bundle);
    built.set(bundle, definitions);
    definitions.catch(() => built.delete(bundle));
  }
  return definitions;
}

export async function sessionDefinitions(
  ctx: Pick<ContextReader, "require">,
): Promise<readonly Definition[]> {
  return await agentDefinitions(ctx.require(BundleKey));
}

async function buildAgentDefinitions(bundle: CompiledBundle): Promise<readonly Definition[]> {
  const agent = bundle.resolvedAgent;
  const model = await loadModelDefinition(bundle);
  const staticModel = agentModel(bundle);
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
    parentModel,
  ];
}

function scheduleToolsDefinition(collection: ResolvedScheduleCollection): Definition {
  const slug = scheduleCollectionToolPrefix(collection.name);
  return toolsDefinition({ logicalPath: `tools/${slug}.ts`, slug }, async () => {
    const { scheduleCollectionTools } = await import("#context/schedule-collection-tools.js");
    return scheduleCollectionTools(collection.definition, collection.name);
  });
}
