import { runOnSelection, type ContextContainer } from "#context/container.js";
import type { ContextReader } from "#context/key.js";
import { StaticModelReferenceKey, type LiveDynamicModelSelection } from "#context/keys.js";
import { isMockModel } from "#internal/mock-model-identity.js";
import {
  loadDynamicRuntimeModelDefinition,
  resolveRuntimeModelSelection,
  shouldMockAuthoredRuntimeModels,
} from "#runtime/agent/resolve-model.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { PublicAgentDynamicModelResult } from "#shared/agent-definition.js";
import { toErrorMessage } from "#shared/errors.js";
import { parseJsonValue, type JsonValue } from "#shared/json.js";
import { modelOptionsOf } from "#dynamic/model-options.js";
import { publicResolveContext, type InternalResolveContext, type Reaction } from "../reaction.js";
import { canonicalJson, readLive, readReactionsState } from "../state.js";

const MODEL_REACTION_ID = "model:agent";
const DYNAMIC_MODEL_SELECTION_ERROR_CODE = "EVE_DYNAMIC_MODEL_SELECTION_FAILED";

/** A dynamic `model` failed to choose a model: the model call that needs it fails. */
export class DynamicModelSelectionError extends Error {
  readonly code = DYNAMIC_MODEL_SELECTION_ERROR_CODE;
  override readonly name = "DynamicModelSelectionError";

  constructor(error: unknown) {
    super(toErrorMessage(error), { cause: error });
  }
}

export function isDynamicModelSelectionError(error: unknown): error is DynamicModelSelectionError {
  return (
    error instanceof DynamicModelSelectionError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { readonly code?: unknown }).code === DYNAMIC_MODEL_SELECTION_ERROR_CODE)
  );
}

/** What the model slot records: the model chosen, and the option auto() chose it as. */
interface ModelSlotValue {
  readonly reference: LiveDynamicModelSelection["reference"];
  readonly choice?: string;
}

/**
 * An agent's dynamic `model` field: `resolve` returns the model for the session. auto() records
 * the option it chose, and a process that didn't choose it rebuilds the model from the option.
 */
export async function loadModelReaction(bundle: CompiledBundle): Promise<Reaction | undefined> {
  const dynamicModel = bundle.turnAgent.dynamicModel;
  if (dynamicModel === undefined) return undefined;
  const definition = await loadDynamicRuntimeModelDefinition({
    dynamicModel,
    scope: { moduleMap: bundle.moduleMap, nodeId: bundle.nodeId },
  });
  const label = `${dynamicModel.logicalPath}#model`;
  const options = modelOptionsOf(definition);

  /** Resolves a model result to what the slot records, and the provider the process holds. */
  async function contributionOf(
    result: unknown,
    ctx: ContextContainer,
    choice: string | undefined,
  ): Promise<{ readonly value: ModelSlotValue; readonly live?: LiveDynamicModelSelection }> {
    const selection = await resolveRuntimeModelSelection({
      durability: "live",
      selection: result as PublicAgentDynamicModelResult,
      state: ctx,
    });
    // Mock runs replace real providers, but keep explicitly scripted responders.
    const live =
      selection.model === undefined ||
      (!isMockModel(selection.model) && shouldMockAuthoredRuntimeModels())
        ? undefined
        : selection;
    return {
      live,
      value: { reference: selection.reference, ...(choice === undefined ? {} : { choice }) },
    };
  }

  return {
    contribute: async (result, { ctx }) => {
      try {
        if (options === undefined) {
          const { live, value } = await contributionOf(result, ctx, undefined);
          return { live, value: value as unknown as JsonValue };
        }
        // auto() resolves to the option it chose, or null before there's a turn to choose for.
        if (result === null) return { value: null };
        const choice = result as string;
        const { live, value } = await contributionOf(optionOf(choice), ctx, choice);
        return { live, value: value as unknown as JsonValue };
      } catch (error) {
        throw new DynamicModelSelectionError(error);
      }
    },
    // A failed selection fails the model call that needs it, not the commit that ran it: a commit
    // before the turn's input, say, may have nothing to choose from yet.
    // auto() reads the conversation before the turn when it chooses, so it runs where a step has it.
    ...(options === undefined ? {} : { conversation: true }),
    id: MODEL_REACTION_ID,
    kind: "model",
    label,
    // A model resolved again in another process must be the one the session chose: switching
    // models mid-turn, or mid-session, would be silent. The model call fails instead.
    reconcile: (recorded, rebuilt) => {
      throw new DynamicModelSelectionError(new Error(modelChangedMessage(recorded, rebuilt.value)));
    },
    ...(options === undefined
      ? {}
      : {
          rebuild: async (recorded: JsonValue, { ctx }: InternalResolveContext) => {
            const choice = (recorded as unknown as ModelSlotValue | null)?.choice;
            if (choice === undefined) return undefined;
            try {
              const rebuilt = await contributionOf(optionOf(choice), ctx, choice);
              const value = parseJsonValue(rebuilt.value as unknown);
              if (canonicalJson(value) !== canonicalJson(recorded)) {
                throw new Error(modelChangedMessage(recorded, value));
              }
              return rebuilt.live;
            } catch (error) {
              throw new DynamicModelSelectionError(error);
            }
          },
        }),
    resolve: async (selected, ctx) => {
      try {
        return await runOnSelection(dynamicModel.logicalPath, () =>
          options === undefined
            ? definition.resolve(selected as never, publicResolveContext(ctx))
            : options.choose(selected as never, {
                ...publicResolveContext(ctx),
                messages: ctx.messages ?? [],
              }),
        );
      } catch (error) {
        throw new DynamicModelSelectionError(error);
      }
    },
    select: definition.select as NonNullable<Reaction["select"]>,
  };

  function optionOf(choice: string): PublicAgentDynamicModelResult {
    const option = options?.option(choice);
    if (option === undefined) {
      throw new Error(
        `The model option "${choice}" this session chose is no longer one of auto()'s options.`,
      );
    }
    return option;
  }
}

function modelChangedMessage(recorded: JsonValue, rebuilt: JsonValue): string {
  const id = (value: JsonValue) =>
    (value as unknown as ModelSlotValue | null)?.reference.id ?? "no model";
  return `The model changed since this session chose it: it chose ${id(recorded)}, and this process resolves ${id(rebuilt)}. eve fails the call rather than switch models; the next change to the selection chooses again.`;
}

/** The model the next call uses: the dynamic agent's, or the static one. Throws a failed selection. */
export function getEffectiveModelSelection(
  ctx: Pick<ContextReader, "get">,
): LiveDynamicModelSelection | null {
  const slot = readReactionsState(ctx).slots[MODEL_REACTION_ID];
  if (slot?.error !== undefined) throw new DynamicModelSelectionError(new Error(slot.error));
  if (slot !== undefined && slot.value !== null) {
    const live = readLive(ctx, MODEL_REACTION_ID, slot);
    return (
      (live?.live as LiveDynamicModelSelection | undefined) ?? {
        reference: (slot.value as unknown as ModelSlotValue).reference,
      }
    );
  }
  const staticModel = ctx.get(StaticModelReferenceKey);
  return staticModel === null || staticModel === undefined ? null : { reference: staticModel };
}

export function effectiveModelId(ctx: ContextContainer): string | undefined {
  try {
    return getEffectiveModelSelection(ctx)?.reference.id;
  } catch {
    return undefined;
  }
}
