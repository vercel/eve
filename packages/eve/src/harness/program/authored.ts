import type { ContextReader } from "#context/key.js";
import type { Memo, SessionFrame } from "#dynamic/definition.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import type {
  Harness,
  HarnessContext,
  HarnessModelStep,
  HarnessPlan,
} from "#public/definitions/harness.js";
import { declaredTool, declaredToolName } from "#public/definitions/harness.js";
import { sessionFrameOf } from "#reactions/frame.js";
import { dynamicInstructionSlugs, HARNESS_INSTRUCTIONS } from "#reactions/kinds/instructions.js";
import { harnessModelReaction } from "#reactions/kinds/model.js";
import { dynamicToolNames, HARNESS_TOOLS, toolReaction } from "#reactions/kinds/tool.js";
import type { InternalContext, ValueReaction } from "#reactions/reaction.js";
import { BundleKey, type CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { HistoryMessage } from "#shared/history-message.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import { nativeNext } from "./native.js";
import { type Compaction, continuationsOf, force, type Program } from "./program.js";

// `agent/harness.ts` is a program authors write. Its `next` and `history` fields are decisions
// the kernel asks for; its `agent` fields are dynamic values, which the bundle evaluates before
// each model call beside the ones the agent's files declare.

type AuthoredHarness = NonNullable<CompiledBundle["resolvedAgent"]["harness"]>;

/** The program `agent/harness.ts` defines, if the session's agent has one. */
export function authoredProgram(ctx: ContextReader | undefined): Program | undefined {
  const authored = ctx?.get(BundleKey)?.resolvedAgent.harness;
  return authored === undefined
    ? undefined
    : harnessProgram(authored.harness, () => sessionFrameOf(ctx!));
}

/** A harness as the kernel asks it: a field it leaves out, or answers `undefined` for, is eve's. */
export function harnessProgram(harness: Harness, frame: () => SessionFrame): Program {
  return (program) => {
    const plan = harness(
      harnessContext({
        compaction: program.compaction,
        frame,
        history: program.history,
        lastStep: program.turn?.lastStep,
        memo: program.memo,
        turnId: program.turn?.id,
      }),
    );
    return {
      ...(plan.history !== undefined && {
        history: async () =>
          ((await force(plan.history)) as readonly HarnessModelMessage[] | undefined) ??
          (program.compaction === undefined
            ? program.history
            : await program.compaction.native(program.history)),
      }),
      next: async () => (await force(plan.next)) ?? nativeNext(program),
    };
  };
}

/** The agent's own instructions, as a harness's `declared.agent`. */
const AGENT_INSTRUCTIONS = "agent";

/**
 * The dynamic values the harness's `agent` fields make: a model, instructions, and tools. Its
 * tools and instructions are all the model gets, besides eve's own, so their slots also name the
 * declared ones they keep: the step's catalog and system prompt read them in any process.
 */
export function harnessValues(
  authored: AuthoredHarness,
  bundle: CompiledBundle,
): {
  readonly model: ValueReaction;
  readonly rest: readonly ValueReaction[];
} {
  const source = { logicalPath: authored.logicalPath, sourceId: authored.logicalPath };
  const agent = (ctx: InternalContext): HarnessPlan["agent"] =>
    authored.harness(fromValue(ctx)).agent;
  const declared = (names: readonly string[]) =>
    Object.fromEntries(names.map((name) => [name, declaredTool(name)]));
  const ownTools = toolReaction({
    ...source,
    evaluate: ((result: unknown) => result) as never,
    framework: true,
    slug: "harness",
  } as never);
  const tools: ValueReaction = {
    ...ownTools,
    contribute: async (result, ctx) => {
      if (result === null) return { value: null };
      const own: Record<string, unknown> = {};
      const kept: JsonObject[] = [];
      for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
        const name = declaredToolName(value);
        if (name === undefined) own[key] = value;
        else kept.push({ declared: true, name });
      }
      const contributed = await ownTools.contribute(own, ctx);
      const mine = Array.isArray(contributed.value) ? contributed.value : [];
      return { live: contributed.live ?? [], value: [...mine, ...kept] };
    },
    evaluate: async (ctx) => {
      const field = agent(ctx)?.tools;
      if (field === undefined) return null;
      if (typeof field !== "function") return field;
      const names = [
        ...bundle.turnAgent.tools.map((tool) => tool.name),
        ...dynamicToolNames(ctx.ctx, { except: HARNESS_TOOLS }),
      ];
      return (await field(declared(names) as never)) ?? null;
    },
    id: HARNESS_TOOLS,
  };
  const instructions: ValueReaction = {
    contribute: (result) => ({ value: result as JsonValue }),
    evaluate: async (ctx) => {
      const field = agent(ctx)?.instructions;
      if (field === undefined) return null;
      const names = [
        AGENT_INSTRUCTIONS,
        ...dynamicInstructionSlugs(ctx.ctx, { except: HARNESS_INSTRUCTIONS }),
      ];
      const value = typeof field === "function" ? await field(declared(names) as never) : field;
      if (value === undefined) return null;
      const parts: readonly unknown[] = typeof value === "string" ? [value] : value;
      return {
        content: parts
          .filter((part) => typeof part === "string")
          .join("\n\n")
          .trim(),
        keep: parts.flatMap((part) => declaredToolName(part) ?? []),
        role: "system",
      };
    },
    id: HARNESS_INSTRUCTIONS,
    kind: "instructions",
    label: authored.logicalPath,
  };
  return {
    model: harnessModelReaction(bundle, {
      evaluate: (ctx) => force(agent(ctx)?.model),
      label: `${authored.logicalPath}#model`,
    }),
    rest: [tools, instructions],
  };
}

function fromValue(ctx: InternalContext): HarnessContext {
  return harnessContext({
    frame: () => ctx,
    history: (ctx.history ?? []) as readonly HarnessModelMessage[],
    memo: ctx.memo,
    turnId: ctx.turn?.status === "settled" ? undefined : ctx.turn?.id,
  });
}

function harnessContext(input: {
  readonly frame: () => SessionFrame;
  readonly history: readonly HarnessModelMessage[];
  readonly memo: Memo;
  readonly turnId: string | undefined;
  readonly lastStep?: HarnessModelStep;
  readonly compaction?: Compaction;
}): HarnessContext {
  const frame = input.frame();
  return {
    channel: frame.channel,
    ...(frame.conversation !== undefined && { conversation: frame.conversation }),
    now: frame.now,
    session: frame.session,
    turn: frame.turn,
    view: frame.view,
    ...(input.compaction !== undefined && {
      compaction: {
        native: async (history: readonly HistoryMessage[]) =>
          (await input.compaction!.native(
            history as readonly HarnessModelMessage[],
          )) as HistoryMessage[],
        reason: input.compaction.reason,
      },
    }),
    continuations: input.turnId === undefined ? 0 : continuationsOf(input.history, input.turnId),
    history: input.history as readonly HistoryMessage[],
    ...(input.lastStep !== undefined && { lastStep: input.lastStep }),
    memo: input.memo,
  };
}
