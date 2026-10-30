import { harnessChoosingModel } from "#reactions/runner.js";
import type { ContextReader } from "#context/key.js";
import { AgentSessionRuntimeOverridesKey, DynamicSubagentAgentConfigKey } from "#context/keys.js";
import { BundleKey, type CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import { connectionReaction, installDynamicConnections } from "./kinds/connection.js";
import { hookReaction } from "./kinds/hook.js";
import { instructionsReaction } from "./kinds/instructions.js";
import { memoryReactions } from "./kinds/memory.js";
import { harnessChoseModel, loadModelReaction } from "./kinds/model.js";
import { skillReaction, syncDynamicSkillFiles } from "./kinds/skill.js";
import { subagentReaction } from "./kinds/subagent.js";
import { toolReaction } from "./kinds/tool.js";
import { harnessValues } from "#harness/policy/authored.js";
import type { BundleReactions, Reaction, ValueReaction } from "./reaction.js";

const cache = new WeakMap<CompiledBundle, Promise<BundleReactions>>();
const EMPTY: BundleReactions = { effects: {}, reactions: [] };

/**
 * The reactions the session's agent declares, in run order: hooks after each commit; then the
 * model, which every later value can read, and each kind that may read the ones before it.
 */
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
  // A dynamic subagent's session, or one opened with a `ctx.agent` model, runs the model its
  // parent selected for it.
  if (!ctx.has(DynamicSubagentAgentConfigKey) && !ctx.has(AgentSessionRuntimeOverridesKey)) {
    return all;
  }
  return { ...all, reactions: all.reactions.filter((reaction) => reaction.kind !== "model") };
}

/**
 * The agent's model, which waits for the harness's: when the harness chose one, it doesn't run.
 * While the harness chooses, it runs: `declared(ctx).model` in the harness's `agent.model` may be
 * about to return it in place of the model it chose before.
 */
function unlessHarnessChose(model: ValueReaction): ValueReaction {
  const skipped = Symbol("skipped");
  return {
    ...model,
    contribute: (result, ctx) =>
      result === skipped ? { value: null } : model.contribute(result, ctx),
    evaluate: (ctx) =>
      !harnessChoosingModel(ctx.ctx) && harnessChoseModel(ctx.ctx) ? skipped : model.evaluate(ctx),
  };
}

async function buildReactions(bundle: CompiledBundle): Promise<BundleReactions> {
  const agent = bundle.resolvedAgent;
  const model = await loadModelReaction(bundle);
  const harness = agent.harness === undefined ? undefined : harnessValues(agent.harness, bundle);
  const declared: ValueReaction[] = [
    ...(model === undefined ? [] : [harness === undefined ? model : unlessHarnessChose(model)]),
    ...(agent.dynamicConnectionResolvers ?? []).map(connectionReaction),
    ...bundle.subagentRegistry.dynamicResolvers.map(subagentReaction),
    ...agent.dynamicToolResolvers.map(toolReaction),
    ...agent.dynamicSkillResolvers.map(skillReaction),
    ...agent.dynamicInstructionsResolvers.map(instructionsReaction),
  ];
  const reactions: Reaction[] = [
    ...agent.hooks.map(hookReaction),
    ...agent.memories.flatMap(memoryReactions),
    ...(harness === undefined
      ? declared
      : [
          harness.model,
          ...declared.map((reaction): ValueReaction => ({ ...reaction, declared: true })),
        ]),
    ...(harness?.rest ?? []),
  ];
  return {
    effects: {
      ...((agent.dynamicConnectionResolvers ?? []).length === 0
        ? {}
        : { connection: installDynamicConnections }),
      ...(agent.dynamicSkillResolvers.length !== 0 && { skill: syncDynamicSkillFiles }),
    },
    reactions,
  };
}
