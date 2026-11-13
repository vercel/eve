import type { ModelMessage } from "ai";

import {
  type AnchoredEntry,
  type Definition,
  type DefinitionContext,
  type Draft,
  EMPTY_TOOLS,
  section,
  SECTION_ORDER,
} from "#definitions/definition.js";
import { type ModelChoice, keptModel } from "#definitions/model.js";
import { readDefinitionsState } from "#definitions/state.js";
import { toolsDefinition } from "#definitions/tools.js";
import {
  createFrameworkUserMessage,
  type HarnessModelMessage,
  isUserModelMessage,
} from "#harness/messages.js";
import { MODEL_METADATA_KIND } from "#internal/model-catalog.js";
import type { HarnessContext } from "#public/definitions/harness.js";
import { compiledBundleOf } from "#runtime/sessions/runtime-context-keys.js";
import { parseJsonValue, type JsonValue } from "#shared/json.js";
import { fromPublicTools, harnessContext, partsOf, sectionsOf, toPublicTools } from "./context.js";
import type { HarnessLayer, HarnessStack } from "./stack.js";

// A harness's layers, as definitions in the agent's one ordered list. Each layer is its own
// definition, and a later definition wraps the ones before it, so the stack's innermost layer
// comes first. A layer's stages that shape a request (`tools`, `instructions`, `context`, and
// `model`) wrap what the definitions before it made; its values and `on` handlers are collected
// like any file's. The stages the kernel asks at its decision points (`next`, `request`, `admit`,
// and `compact`) read the layer off its definition.

/** The definitions a stack adds to its agent's, innermost first. */
export function harnessDefinitions(stack: HarnessStack): readonly Definition[] {
  return [...stack.layers]
    .reverse()
    .flatMap((layer, index) => [...valueTools(layer, index), layerDefinition(layer, index)]);
}

function layerDefinition(layer: HarnessLayer, index: number): Definition {
  const stages = layer.definition;
  const added =
    typeof stages.instructions === "string"
      ? [
          section(layer.label, stages.instructions, {
            order: SECTION_ORDER.dynamicInstructions + 1,
          }),
        ]
      : undefined;
  return {
    contribute: (dctx) => {
      // What the stages read: the session, with the layers below this one as `ctx.harness`.
      const ctx = (draft?: Draft): HarnessContext =>
        harnessContext(dctx.container, {
          history: dctx.history ?? [],
          ...(dctx.step?.view !== undefined && { view: dctx.step.view().projection.view }),
          system: draft?.system ?? (async () => []),
          tools: draft?.tools ?? (async () => EMPTY_TOOLS),
        });
      const tools = stages.tools;
      const instructions = stages.instructions;
      const context = stages.context;
      const model = stages.model;
      return {
        ...(added !== undefined && { system: added }),
        ...(stages.on !== undefined && { effects: () => onEffects(layer, dctx, ctx()) }),
        ...(typeof model === "function" && {
          arrangeModel: (below) => layerModel(dctx, ctx(), model, below),
        }),
        arrange: (draft) => ({
          ...(typeof tools === "function" && {
            tools: async () => {
              const below = await draft.tools();
              const chosen = await tools(ctx(draft), async () => toPublicTools(below));
              return fromPublicTools(below, chosen, layer.label);
            },
          }),
          ...(typeof instructions === "function" && {
            system: async () => {
              const below = await draft.system();
              const parts = await instructions(ctx(draft), async () => partsOf(below));
              return sectionsOf(below, parts, layer.label);
            },
          }),
          ...(typeof context === "function" && {
            context: async () => await layerContext(dctx, ctx(draft), context, draft),
          }),
        }),
      };
    },
    id: `harness:${layer.namespace ?? ""}:${layer.label}:${index}`,
    label: layer.label,
    layer,
  };
}

// --- Context ----------------------------------------------------------------------------------

/** What a layer's `context` kept: each turn's messages, as it returned them. */
interface KeptContext {
  readonly cleared: number | null;
  readonly turns: readonly { readonly turnId: string; readonly messages: readonly JsonValue[] }[];
}

/**
 * A layer's `context`: asked once per turn, as the turn's first model call is drafted, with what
 * the layers below placed for that turn, and kept with the turn. Every later call places each
 * turn's kept messages where that turn's input is, so the prompt ahead of them stays cached. A
 * turn the layer has no answer for keeps what the layers below placed. A clear starts over.
 */
async function layerContext(
  dctx: DefinitionContext,
  ctx: HarnessContext,
  context: NonNullable<HarnessLayer["definition"]["context"]>,
  draft: Draft,
): Promise<readonly AnchoredEntry[]> {
  const below = await draft.context();
  const kept = await dctx.keep(async (evaluation, previous) => {
    const turnId = evaluation.turn?.status === "settled" ? undefined : evaluation.turn?.id;
    const cleared = readDefinitionsState(evaluation.ctx).latest["context.settled:clear"] ?? null;
    const earlier = previous as KeptContext | null | undefined;
    const turns = earlier?.cleared === cleared ? earlier.turns : [];
    if (turnId === undefined || turns.some((turn) => turn.turnId === turnId)) {
      return { value: parseJsonValue({ cleared, turns }) };
    }
    const placed = below.filter((entry) => entry.turnId === turnId).map((entry) => entry.message);
    // In a memo: asked once per turn, however often eve evaluates what's kept.
    const messages = await evaluation.memo(["harness.context", turnId], async () =>
      (await context(ctx, async () => placed)).map(asJson),
    );
    return { value: parseJsonValue({ cleared, turns: [...turns, { messages, turnId }] }) };
  });
  const turns = (kept?.value as KeptContext | null | undefined)?.turns ?? [];
  const answered = new Set(turns.map((turn) => turn.turnId));
  return [
    ...below.filter((entry) => !answered.has(entry.turnId)),
    ...turns.flatMap(({ messages, turnId }) =>
      messages.map((message) => ({ message: asContextMessage(message), turnId })),
    ),
  ];
}

function asJson(message: ModelMessage): JsonValue {
  return parseJsonValue(JSON.parse(JSON.stringify(message)));
}

/** A message a layer returned, as context holds it: a user message it wrote is the framework's. */
function asContextMessage(value: JsonValue): HarnessModelMessage {
  const message = value as ModelMessage;
  if (message.role !== "user" || isUserModelMessage(message)) return message as HarnessModelMessage;
  return createFrameworkUserMessage("context.instruction", message.content);
}

// --- Model ------------------------------------------------------------------------------------

/**
 * A layer's `model`: the model the layers below chose, or another gateway model ID it names,
 * which eve keeps like a dynamic model, so every reader of the call sees the same choice.
 */
async function layerModel(
  dctx: DefinitionContext,
  ctx: HarnessContext,
  model: NonNullable<HarnessLayer["definition"]["model"]>,
  below: () => Promise<ModelChoice | undefined>,
): Promise<ModelChoice | undefined> {
  const kept = await dctx.keep(
    async () => {
      const under = await below();
      const chosen = await model(ctx, async () => under?.reference.id);
      if (chosen === undefined || chosen === under?.reference.id) return null;
      return await keptModel(chosen, modelMetadataOf(dctx));
    },
    { choosesModel: true },
  );
  const value = kept?.value as { readonly reference: ModelChoice["reference"] } | null;
  if (value === null || value === undefined) return await below();
  return (kept?.live as ModelChoice | undefined) ?? { reference: value.reference };
}

function modelMetadataOf(dctx: DefinitionContext) {
  return (
    compiledBundleOf(dctx.container)?.modelMetadata ??
    (async () => ({
      fetchedAt: null,
      kind: MODEL_METADATA_KIND,
      models: [],
      providerAliases: {},
      version: 1 as const,
    }))
  );
}

// --- On ---------------------------------------------------------------------------------------

/** A layer's `on` handlers, as effects of the commits that carry the events they name. */
function onEffects(layer: HarnessLayer, dctx: DefinitionContext, ctx: HarnessContext) {
  const handlers = (layer.definition.on ?? {}) as Readonly<Record<string, unknown>>;
  return (dctx.commit?.written ?? []).flatMap(({ event, position }) => {
    const handler = handlers[event.type];
    if (typeof handler !== "function") return [];
    return [
      {
        id: `${layer.label}:on:${event.type}:${position}`,
        run: async () => {
          await (handler as (event: unknown, ctx: HarnessContext) => unknown)(event, ctx);
        },
      },
    ];
  });
}

// --- Values -----------------------------------------------------------------------------------

/** The tools a layer adds with `tools: { ... }`, named as a tool file in its mount would be. */
function valueTools(layer: HarnessLayer, index: number): readonly Definition[] {
  const tools = layer.definition.tools;
  if (tools === undefined || typeof tools === "function") return [];
  return [
    toolsDefinition(
      {
        logicalPath: layer.label,
        slug: `harness-${index}`,
        ...(layer.namespace !== undefined && { extensionNamespace: layer.namespace }),
      },
      () => tools,
    ),
  ];
}
