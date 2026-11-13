import { ContextKey, type ContextAccessor, type ContextReader } from "#context/key.js";
import {
  AgentSessionRuntimeOverridesKey,
  DynamicSubagentAgentConfigKey,
  type LiveDynamicModelSelection,
} from "#context/keys.js";
import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";
import { compiledBundleOf } from "#runtime/sessions/runtime-context-keys.js";
import { isMockModel } from "#internal/mock-model-identity.js";
import {
  loadDynamicRuntimeModelDefinition,
  resolveRuntimeModelSelection,
  shouldMockAuthoredRuntimeModels,
} from "#runtime/agent/resolve-model.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { PublicAgentDynamicModelResult } from "#shared/agent-definition.js";
import { toErrorMessage } from "#shared/errors.js";
import { dynamicEvaluate } from "#dynamic/definition.js";
import { parseJsonValue } from "#shared/json.js";
import { decideModel } from "./combine.js";
import {
  authoredEvaluate,
  type Contribution,
  type Definition,
  type InternalContext,
  type Kept,
} from "./definition.js";
import type { ModelMetadata } from "#internal/model-catalog.js";

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

/** The model a call runs: its reference, and the provider the process holds for it, if any. */
export type ModelChoice = LiveDynamicModelSelection;

/** What the model slot records: the model chosen. */
interface ModelSlotValue {
  readonly reference: LiveDynamicModelSelection["reference"];
}

/**
 * An agent's dynamic `model` field: its function returns the model, as a gateway ID, a provider
 * object, or `{ model, reasoning?, modelContextWindowTokens?, modelOptions? }`. It's chosen before
 * every other value evaluates, so each can read `ctx.model`. A model call needs a model, so `null`
 * fails it.
 */
export async function loadModelDefinition(bundle: CompiledBundle): Promise<Definition | undefined> {
  const dynamicModel = bundle.turnAgent.dynamicModel;
  if (dynamicModel === undefined) return undefined;
  const definition = await loadDynamicRuntimeModelDefinition({
    dynamicModel,
    scope: { moduleMap: bundle.moduleMap, nodeId: bundle.nodeId },
  });
  return modelDefinition(bundle.modelMetadata, {
    choose: authoredEvaluate(dynamicEvaluate(definition)),
    id: MODEL_REACTION_ID,
    label: `${dynamicModel.logicalPath}#model`,
  });
}

/** A definition that chooses the model. */
function modelDefinition(
  modelMetadata: () => Promise<ModelMetadata>,
  input: {
    readonly id: string;
    readonly label: string;
    readonly choose: (ctx: InternalContext) => unknown;
  },
): Definition {
  return {
    contribute: (ctx) => ({
      model: async () => {
        const kept = await ctx.keep(
          async (evaluation) => {
            const result = await input.choose(evaluation);
            try {
              return await keptModel(result, modelMetadata);
            } catch (error) {
              throw new DynamicModelSelectionError(error);
            }
          },
          { choosesModel: true },
        );
        const value = kept?.value as ModelSlotValue | null | undefined;
        if (value === null || value === undefined) return undefined;
        return (kept?.live as ModelChoice | undefined) ?? { reference: value.reference };
      },
    }),
    id: input.id,
    label: input.label,
  };
}

/** Resolves a model result to what the slot records, and the provider the process holds. */
async function keptModel(
  result: unknown,
  modelMetadata: () => Promise<ModelMetadata>,
): Promise<Kept> {
  const selection = await resolveRuntimeModelSelection({
    durability: "live",
    modelMetadata,
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

/**
 * The model the session chose last, as its definitions decided before a model call. Readers
 * outside the call, such as `ctx.model`, read it.
 */
export const ChosenModelKey = new ContextKey<{ readonly reference: RuntimeModelReference }>(
  "eve.model",
);

/** What the session's definitions decide the model call runs, and records it as the session's choice. */
export async function chooseModel(
  contributions: readonly Contribution[],
  ctx: ContextAccessor,
): Promise<ModelChoice | undefined> {
  const choice = await decideModel(contributions);
  if (choice !== undefined) {
    ctx.set(ChosenModelKey, { reference: choice.reference });
  }
  return choice;
}

/** The session's model outside a model call: the one it chose last, else the one it was given. */
export function currentModel(ctx: Pick<ContextReader, "get">): RuntimeModelReference | undefined {
  return (
    ctx.get(ChosenModelKey)?.reference ?? givenModel(ctx) ?? compiledBundleOf(ctx)?.turnAgent.model
  );
}

export function effectiveModelId(ctx: Pick<ContextReader, "get">): string | undefined {
  return currentModel(ctx)?.id;
}

/** The model a session's parent gave it: a `ctx.agent` model, or a dynamic subagent's config's. */
function givenModel(ctx: Pick<ContextReader, "get">): RuntimeModelReference | undefined {
  return (
    ctx.get(AgentSessionRuntimeOverridesKey)?.model ?? ctx.get(DynamicSubagentAgentConfigKey)?.model
  );
}

/** `agent.ts`'s model, which every dynamic choice after it may replace. */
export function agentModel(bundle: CompiledBundle): Definition | undefined {
  const reference = bundle.turnAgent.model;
  if (reference === undefined) return undefined;
  return {
    contribute: () => ({ model: () => ({ reference }) }),
    id: "eve.model",
    label: "agent.ts#model",
  };
}

/** The model a session's parent gave it, which no definition of the session's own replaces. */
export const parentModel: Definition = {
  contribute: ({ container }) => ({
    model: () => {
      const reference = givenModel(container);
      return reference === undefined ? undefined : { reference };
    },
  }),
  id: "eve.model.parent",
  label: "the model the session was given",
};
