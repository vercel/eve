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
import { dynamicEvaluate, isFrameworkDefinition } from "#dynamic/definition.js";
import { parseJsonValue, type JsonValue } from "#shared/json.js";
import { authoredEvaluate, type ValueReaction } from "../reaction.js";
import { readLive, readReactionsState, slotValueOf } from "../state.js";

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

/** What the model slot records: the model chosen. */
interface ModelSlotValue {
  readonly reference: LiveDynamicModelSelection["reference"];
}

/**
 * An agent's dynamic `model` field: its function returns the model, as a gateway ID, a provider
 * object, or `{ model, reasoning?, modelContextWindowTokens?, modelOptions? }`. It runs first
 * among dynamic values, so every later one can read `ctx.model`. A model call needs a model, so
 * `null` fails it.
 */
export async function loadModelReaction(
  bundle: CompiledBundle,
): Promise<ValueReaction | undefined> {
  const dynamicModel = bundle.turnAgent.dynamicModel;
  if (dynamicModel === undefined) return undefined;
  const definition = await loadDynamicRuntimeModelDefinition({
    dynamicModel,
    scope: { moduleMap: bundle.moduleMap, nodeId: bundle.nodeId },
  });
  const label = `${dynamicModel.logicalPath}#model`;
  return {
    contribute: async (result) => {
      try {
        return await contributionOf(result, bundle);
      } catch (error) {
        throw new DynamicModelSelectionError(error);
      }
    },
    evaluate: authoredEvaluate(dynamicEvaluate(definition), {
      framework: isFrameworkDefinition(definition),
    }),
    id: MODEL_REACTION_ID,
    kind: "model",
    label,
  };
}

const HARNESS_MODEL_ID = "model:harness";

/**
 * The model `agent/harness.ts` chooses, in place of the agent's. `null` or `undefined` leaves the
 * agent's own.
 */
export function harnessModelReaction(
  bundle: CompiledBundle,
  input: { readonly evaluate: ValueReaction["evaluate"]; readonly label: string },
): ValueReaction {
  return {
    contribute: async (result) => {
      if (result === null || result === undefined) return { value: null };
      try {
        return await contributionOf(result, bundle);
      } catch (error) {
        throw new DynamicModelSelectionError(error);
      }
    },
    evaluate: input.evaluate,
    id: HARNESS_MODEL_ID,
    kind: "model",
    label: input.label,
  };
}

/** Resolves a model result to what the slot records, and the provider the process holds. */
async function contributionOf(
  result: unknown,
  bundle: CompiledBundle,
): Promise<{ readonly value: JsonValue; readonly live?: LiveDynamicModelSelection }> {
  const selection = await resolveRuntimeModelSelection({
    durability: "live",
    modelMetadata: bundle.modelMetadata,
    selection: result as PublicAgentDynamicModelResult,
  });
  // Mock runs replace real providers, but keep explicitly scripted responders.
  const live =
    selection.model === undefined ||
    (!isMockModel(selection.model) && shouldMockAuthoredRuntimeModels())
      ? undefined
      : selection;
  const value: ModelSlotValue = { reference: selection.reference };
  return { live, value: parseJsonValue(value) };
}

/** The model the next call uses: the dynamic agent's, or the static one. */
/** The harness chose this step's model: the agent's own dynamic model doesn't run. */
export function harnessChoseModel(ctx: Pick<ContextReader, "get">): boolean {
  const slot = readReactionsState(ctx).slots[HARNESS_MODEL_ID];
  return slot !== undefined && slot.value !== null;
}

export function getEffectiveModelSelection(
  ctx: Pick<ContextReader, "get">,
): LiveDynamicModelSelection | null {
  const { slots } = readReactionsState(ctx);
  for (const id of [HARNESS_MODEL_ID, MODEL_REACTION_ID]) {
    const slot = slots[id];
    if (slot === undefined || slot.value === null) continue;
    const live = readLive(ctx, id, slot);
    return (
      (live?.live as LiveDynamicModelSelection | undefined) ?? {
        reference: slotValueOf<ModelSlotValue>(slot.value).reference,
      }
    );
  }
  const staticModel = ctx.get(StaticModelReferenceKey);
  return staticModel === null || staticModel === undefined ? null : { reference: staticModel };
}

export function effectiveModelId(ctx: Pick<ContextReader, "get">): string | undefined {
  try {
    return getEffectiveModelSelection(ctx)?.reference.id;
  } catch {
    return undefined;
  }
}
