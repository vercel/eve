import type { ContextReader } from "#context/key.js";
import type { Memo, SessionFrame } from "#dynamic/definition.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import type {
  Harness,
  HarnessContext,
  HarnessModelStep,
  HarnessPlan,
} from "#public/definitions/harness.js";
import { defineInstructions } from "#public/definitions/instructions.js";
import { sessionFrameOf } from "#reactions/frame.js";
import { instructionsReaction } from "#reactions/kinds/instructions.js";
import { harnessModelReaction } from "#reactions/kinds/model.js";
import { toolReaction } from "#reactions/kinds/tool.js";
import type { InternalContext, ValueReaction } from "#reactions/reaction.js";
import { BundleKey, type CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { HistoryMessage } from "#shared/history-message.js";
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

/** The dynamic values the harness's `agent` fields make: a model, instructions, and tools. */
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
  const instructions = instructionsReaction({
    ...source,
    evaluate: async (ctx: InternalContext) => {
      const value = await force(agent(ctx)?.instructions);
      const content = (typeof value === "string" ? [value] : (value ?? [])).join("\n\n");
      return content.trim() === "" ? null : defineInstructions({ content });
    },
    framework: true,
    slug: "harness",
  } as never);
  const tools = toolReaction({
    ...source,
    evaluate: ((ctx: InternalContext) => force(agent(ctx)?.tools)) as never,
    framework: true,
    slug: "harness",
  } as never);
  return {
    model: harnessModelReaction(bundle, {
      evaluate: (ctx) => force(agent(ctx)?.model),
      label: `${authored.logicalPath}#model`,
    }),
    rest: [
      { ...tools, id: "tool:@harness" },
      { ...instructions, id: "instructions:@harness" },
    ],
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
