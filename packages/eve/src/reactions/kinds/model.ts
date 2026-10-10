import type { ContextContainer } from "#context/container.js";
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
import type { JsonValue } from "#shared/json.js";
import type { Reaction } from "../reaction.js";
import { readLive, readReactionsState } from "../state.js";

const MODEL_REACTION_ID = "model:agent";
const DYNAMIC_MODEL_SELECTION_ERROR_CODE = "EVE_DYNAMIC_MODEL_SELECTION_FAILED";

/** A dynamic `agent.ts` failed to choose a model: the session fails. */
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

/** A dynamic `agent.ts`: `resolve` returns `defineAgent({ model, ... })` for the session. */
export async function loadModelReaction(bundle: CompiledBundle): Promise<Reaction | undefined> {
  const dynamicModel = bundle.turnAgent.dynamicModel;
  if (dynamicModel === undefined) return undefined;
  const definition = await loadDynamicRuntimeModelDefinition({
    dynamicModel,
    scope: { moduleMap: bundle.moduleMap, nodeId: bundle.nodeId },
  });
  return {
    contribute: async (result, { ctx }) => {
      try {
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
        return { live, value: selection.reference as unknown as JsonValue };
      } catch (error) {
        throw new DynamicModelSelectionError(error);
      }
    },
    failure: "throw",
    id: MODEL_REACTION_ID,
    kind: "model",
    label: dynamicModel.logicalPath,
    resolve: async (selected, ctx) => {
      try {
        return await definition.resolve(selected as never, ctx);
      } catch (error) {
        throw new DynamicModelSelectionError(error);
      }
    },
    ...(definition.select === undefined
      ? {}
      : { select: definition.select as NonNullable<Reaction["select"]> }),
  };
}

/** The model the next call uses: the dynamic agent's, or the static one. */
export function getEffectiveModelSelection(
  ctx: Pick<ContextReader, "get">,
): LiveDynamicModelSelection | null {
  const slot = readReactionsState(ctx).slots[MODEL_REACTION_ID];
  if (slot !== undefined && slot.value !== null) {
    const live = readLive(ctx, MODEL_REACTION_ID, slot);
    return (
      (live?.live as LiveDynamicModelSelection | undefined) ?? {
        reference: slot.value as unknown as LiveDynamicModelSelection["reference"],
      }
    );
  }
  const staticModel = ctx.get(StaticModelReferenceKey);
  return staticModel === null || staticModel === undefined ? null : { reference: staticModel };
}

export function effectiveModelId(ctx: ContextContainer): string | undefined {
  return getEffectiveModelSelection(ctx)?.reference.id;
}
