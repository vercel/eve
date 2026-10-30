import { whileChoosingModel } from "#reactions/runner.js";
import type { ContextContainer } from "#context/container.js";
import type { ContextReader } from "#context/key.js";
import type { Memo, SessionFrame } from "#dynamic/definition.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import { sessionTables } from "#protocol/session-projection/session-view.js";
import { callTurn } from "#protocol/session-projection/selectors.js";
import type {
  HarnessHistoryMessage,
  Harness,
  HarnessCall,
  HarnessContext,
  HarnessModelStep,
  HarnessPlan,
} from "#public/definitions/harness.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import { sessionFrameOf } from "#reactions/frame.js";
import { HARNESS_INSTRUCTIONS } from "#reactions/kinds/instructions.js";
import { harnessModelReaction } from "#reactions/kinds/model.js";
import { contributeTools, HARNESS_TOOLS } from "#reactions/kinds/tool.js";
import { builtinName, CONTAINER, declaredName, DESCRIBED } from "./agent.js";
import type { InternalContext, ValueReaction } from "#reactions/reaction.js";
import { BundleKey, type CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";

import { nativeNext } from "./native.js";
import { continuationsOf, force, type Policy, type PolicyContext } from "./policy.js";

// `agent/harness.ts` is a policy authors write. Its `next` and `history` fields are decisions
// the kernel asks for; its `agent` fields are dynamic values, which the bundle evaluates before
// each model call beside the ones the agent's files declare.

type AuthoredHarness = NonNullable<CompiledBundle["resolvedAgent"]["harness"]>;

/** The policy `agent/harness.ts` defines, if the session's agent has one. */
export function authoredPolicy(ctx: ContextReader | undefined): Policy | undefined {
  const authored = ctx?.get(BundleKey)?.resolvedAgent.harness;
  return authored === undefined
    ? undefined
    : harnessPolicy(authored.harness, () => sessionFrameOf(ctx!), ctx as ContextContainer);
}

/** A harness as the kernel asks it: a field it leaves out, or answers `undefined` for, is eve's. */
export function harnessPolicy(
  harness: Harness,
  frame: () => SessionFrame,
  container?: ContextContainer,
): Policy {
  return (policy) => {
    const plan = harness(
      harnessContext({
        container,
        ...(policy.compact !== undefined && { compact: policy.compact }),
        frame,
        history: policy.history,
        lastStep: policy.turn?.lastStep,
        memo: policy.memo,
        ...(policy.size !== undefined && { size: policy.size }),
        summarize: policy.summarize,
        turnId: policy.turn?.id,
        continuations: policy.turn?.continuations ?? 0,
      }),
    );
    return {
      ...(plan.history !== undefined && {
        history: async () =>
          (await force(plan.history)) as readonly HarnessModelMessage[] | undefined,
      }),
      next: async () => (await force(plan.next)) ?? nativeNext(policy),
    };
  };
}

/**
 * The dynamic values the harness's `agent` fields make: a model, instructions, and tools. Its
 * tools and instructions are all the model gets, so their slots record what the harness offers:
 * its own tools, the declared tools it offers by name, the `eve__` tools it allows, and the exact
 * parts of the system prompt. The step's catalog and system prompt read them in any process.
 */
export function harnessValues(
  authored: AuthoredHarness,
  bundle: CompiledBundle,
): {
  readonly model: ValueReaction;
  readonly rest: readonly ValueReaction[];
} {
  const source = { logicalPath: authored.logicalPath };
  const agent = (ctx: InternalContext): HarnessPlan["agent"] =>
    authored.harness(fromValue(ctx)).agent;
  const tools: ValueReaction = {
    contribute: async (result, ctx) => {
      if (result === null) return { value: null };
      const own: Record<string, unknown> = {};
      const offered: JsonObject[] = [];
      for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
        const builtin = builtinName(value);
        const name = declaredName(value);
        if (builtin !== undefined) offered.push({ builtin: true, name: builtin });
        else if (name === undefined) own[key] = value;
        else offered.push(declaredOffer(authored.logicalPath, key, name, value));
      }
      const contributed = contributeTools({ ...source, slug: "harness" }, own, ctx.ctx);
      const mine = Array.isArray(contributed.value) ? contributed.value : [];
      return { live: contributed.live ?? [], value: [...mine, ...offered] };
    },
    evaluate: async (ctx) => (await force(agent(ctx)?.tools)) ?? null,
    id: HARNESS_TOOLS,
    kind: "tool",
    label: authored.logicalPath,
  };
  const instructions: ValueReaction = {
    contribute: (result) => ({ value: result as JsonValue }),
    evaluate: async (ctx) => {
      const value = await force(agent(ctx)?.instructions);
      if (value === undefined) return null;
      return { parts: typeof value === "string" ? value : [...value], role: "system" };
    },
    id: HARNESS_INSTRUCTIONS,
    kind: "instructions",
    label: authored.logicalPath,
  };
  return {
    model: harnessModelReaction(bundle, {
      evaluate: (ctx) => whileChoosingModel(ctx.ctx, () => force(agent(ctx)?.model)),
      label: `${authored.logicalPath}#model`,
    }),
    rest: [tools, instructions],
  };
}

/**
 * A declared tool the harness offers: under its own name, running as declared. A copy may change
 * its description; its approval is the declared tool's, so a copy that sets one is refused.
 */
function declaredOffer(path: string, key: string, name: string, value: unknown): JsonObject {
  if (key !== name) {
    throw new Error(
      `${path} offers the declared tool "${name}" as "${key}". A declared tool keeps its name; offer it as "${name}".`,
    );
  }
  if (typeof value === "object" && value !== null && "approval" in value) {
    throw new Error(
      `${path} sets an approval on the declared tool "${name}". A declared tool keeps its own approval.`,
    );
  }
  const { description, [DESCRIBED]: described } = value as {
    readonly description?: unknown;
    readonly [DESCRIBED]?: unknown;
  };
  return {
    declared: true,
    name,
    ...(typeof description === "string" && description !== described && { description }),
  };
}

function fromValue(ctx: InternalContext): HarnessContext {
  return harnessContext({
    container: ctx.ctx,
    frame: () => ctx,
    history: (ctx.history ?? []) as readonly HarnessModelMessage[],
    memo: ctx.memo,
    summarize: () => {
      throw new Error("eve summarizes the history only where it asks for the history.");
    },
    turnId: ctx.turn?.status === "settled" ? undefined : ctx.turn?.id,
    // A dynamic value's context holds no session state: the notes its history still holds.
    continuations:
      ctx.turn === null || ctx.turn === undefined || ctx.turn.status === "settled"
        ? 0
        : continuationsOf((ctx.history ?? []) as readonly HarnessModelMessage[], ctx.turn.id),
  });
}

function harnessContext(input: {
  readonly container?: ContextContainer;
  readonly frame: () => SessionFrame;
  readonly history: readonly HarnessModelMessage[];
  readonly memo: Memo;
  readonly turnId: string | undefined;
  /** Notes this harness added to the running turn. */
  readonly continuations: number;
  readonly lastStep?: HarnessModelStep;
  readonly compact?: true;
  readonly size?: PolicyContext["size"];
  readonly summarize: PolicyContext["summarize"];
}): HarnessContext {
  const frame = input.frame();
  const turn = turnFacts(
    frame.view === undefined ? undefined : sessionTables(frame.view),
    input.turnId,
  );
  return {
    ...turn,
    ...(input.container !== undefined && { [CONTAINER]: input.container }),
    channel: frame.channel,
    ...(frame.conversation !== undefined && { conversation: frame.conversation }),
    now: frame.now,
    session: frame.session,
    turn: frame.turn,
    view: frame.view,
    ...(input.compact !== undefined && { compact: input.compact }),
    ...(input.size !== undefined && { size: input.size }),
    summarize: async (history, options) =>
      (await input.summarize(
        history as readonly HarnessModelMessage[],
        options,
      )) as HarnessHistoryMessage[],
    continuations: input.continuations,
    history: input.history as readonly HarnessHistoryMessage[],
    ...(input.lastStep !== undefined && { lastStep: input.lastStep }),
    memo: input.memo,
  };
}

function turnFacts(
  view: SessionView | undefined,
  turnId: string | undefined,
): Pick<HarnessContext, "calls" | "steps"> {
  if (view === undefined || turnId === undefined) return { calls: [], steps: 0 };
  const steps = view.turns[turnId]?.runs ?? 0;
  const calls = Object.values(view.calls)
    .filter((row) => callTurn(view, row) === turnId)
    .sort((a, b) => a.introducedAt - b.introducedAt)
    .map((row): HarnessCall => ({
      callId: row.callId,
      kind: row.capability.kind,
      status: row.status,
      tool: row.capability.name,
      ...(row.input !== undefined && { input: row.input }),
      ...(row.outcome !== undefined && { outcome: row.outcome }),
      ...(row.output !== undefined && { output: row.output }),
      ...(row.error !== undefined && { error: { message: row.error.message } }),
    }));
  return { calls, steps };
}
