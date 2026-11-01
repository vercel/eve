import type { ContextReader } from "#context/key.js";
import { memoryDefinition, memoryToolsDefinition } from "#memory/definition.js";
import { BundleKey, type CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import { declared } from "#runtime/types.js";
import { approvals } from "./approvals.js";
import { builtins } from "./builtins.js";
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

// eve's own harness: a definition for each file the agent declares, then eve's builtins, which
// see everything the agent declares, and the model the session's parent gave it.

const built = new WeakMap<CompiledBundle, Promise<readonly Definition[]>>();

/** The definitions the session's agent declares, built once per bundle. */
export function agentDefinitions(bundle: CompiledBundle): Promise<readonly Definition[]> {
  let definitions = built.get(bundle);
  if (definitions === undefined) {
    definitions = buildAgentDefinitions(bundle);
    built.set(bundle, definitions);
    definitions.catch(() => built.delete(bundle));
  }
  return definitions;
}

/** The session's definitions. */
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
    skills,
    ...declared(agent, "skill").map(skillDefinition),
    connections,
    ...declared(agent, "connection").map(connectionDefinition),
    approvals,
    builtins,
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
