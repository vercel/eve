import type { ContextReader } from "#context/key.js";
import { DynamicSubagentAgentConfigKey } from "#context/keys.js";
import { BundleKey, type CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import { connectionReaction, installDynamicConnections } from "./kinds/connection.js";
import { hookReaction } from "./kinds/hook.js";
import { instructionsReaction } from "./kinds/instructions.js";
import { memoryReactions } from "./kinds/memory.js";
import { loadModelReaction } from "./kinds/model.js";
import { skillReaction, syncDynamicSkillFiles } from "./kinds/skill.js";
import { subagentReaction } from "./kinds/subagent.js";
import { toolReaction } from "./kinds/tool.js";
import { REACTION_ORDER, type BundleReactions, type Reaction } from "./reaction.js";

const cache = new WeakMap<CompiledBundle, Promise<BundleReactions>>();
const EMPTY: BundleReactions = { effects: {}, reactions: [] };

/** The reactions the session's agent declares, in run order. */
export async function bundleReactions(
  ctx: Pick<ContextReader, "get" | "has">,
): Promise<BundleReactions> {
  const bundle = ctx.get(BundleKey);
  if (bundle === undefined) return EMPTY;
  let built = cache.get(bundle);
  if (built === undefined) {
    built = buildReactions(bundle);
    cache.set(bundle, built);
    built.catch(() => cache.delete(bundle));
  }
  const all = await built;
  // A dynamic subagent's session runs the model its parent selected for it.
  if (!ctx.has(DynamicSubagentAgentConfigKey)) return all;
  return { ...all, reactions: all.reactions.filter((reaction) => reaction.kind !== "model") };
}

async function buildReactions(bundle: CompiledBundle): Promise<BundleReactions> {
  const agent = bundle.resolvedAgent;
  const model = await loadModelReaction(bundle);
  const reactions: Reaction[] = [
    ...agent.hooks.map(hookReaction),
    ...agent.memories.flatMap(memoryReactions),
    ...(model === undefined ? [] : [model]),
    ...(agent.dynamicConnectionResolvers ?? []).map(connectionReaction),
    ...bundle.subagentRegistry.dynamicResolvers.map(subagentReaction),
    ...agent.dynamicToolResolvers.map(toolReaction),
    ...agent.dynamicSkillResolvers.map(skillReaction),
    ...agent.dynamicInstructionsResolvers.map(instructionsReaction),
  ];
  reactions.sort(
    (left, right) => REACTION_ORDER.indexOf(left.kind) - REACTION_ORDER.indexOf(right.kind),
  );
  return {
    effects: {
      ...((agent.dynamicConnectionResolvers ?? []).length === 0
        ? {}
        : { connection: installDynamicConnections }),
      ...(agent.dynamicSkillResolvers.length === 0 ? {} : { skill: syncDynamicSkillFiles }),
    },
    reactions,
  };
}
