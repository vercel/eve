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
const COMPACTION_MODEL_ID = "model:compaction";
const DYNAMIC_MODEL_SELECTION_ERROR_CODE = "EVE_DYNAMIC_MODEL_SELECTION_FAILED";

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

export type ModelChoice = LiveDynamicModelSelection;

interface ModelSlotValue {
  readonly reference: LiveDynamicModelSelection["reference"];
}

export async function loadModelDefinition(bundle: CompiledBundle): Promise<Definition | undefined> {
  const dynamicModel = bundle.turnAgent.dynamicModel;
  if (dynamicModel === undefined) return undefined;
  const definition = await loadDynamicRuntimeModelDefinition({
    dynamicModel,
    scope: { moduleMap: bundle.moduleMap, nodeId: bundle.nodeId },
  });
  return modelDefinition(bundle.modelMetadata, {
    choose: authoredEvaluate(dynamicEvaluate(definition)),
    field: "model",
    id: MODEL_REACTION_ID,
    label: `${dynamicModel.logicalPath}#model`,
  });
}

export function compactionModelDefinition(bundle: CompiledBundle): Definition | undefined {
  const config = bundle.resolvedAgent.config;
  const dynamicModel = config?.compaction?.dynamicModel;
  if (dynamicModel === undefined) return undefined;
  return modelDefinition(bundle.modelMetadata, {
    choose: authoredEvaluate(dynamicEvaluate(dynamicModel)),
    field: "compactionModel",
    id: COMPACTION_MODEL_ID,
    label: `${config?.source?.logicalPath ?? "agent.ts"}#compaction.model`,
  });
}

function modelDefinition(
  modelMetadata: () => Promise<ModelMetadata>,
  input: {
    readonly id: string;
    readonly label: string;
    readonly field: "compactionModel" | "model";
    readonly choose: (ctx: InternalContext) => unknown;
  },
): Definition {
  const choosesModel = input.field === "model";
  return {
    contribute: (ctx) => ({
      [input.field]: async () => {
        const kept = await ctx.keep(
          async (evaluation) => {
            const result = await input.choose(evaluation);
            if (!choosesModel && (result === null || result === undefined)) return null;
            try {
              return await keptModel(result, modelMetadata, choosesModel);
            } catch (error) {
              throw new DynamicModelSelectionError(error);
            }
          },
          choosesModel ? { choosesModel: true } : undefined,
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

async function keptModel(
  result: unknown,
  modelMetadata: () => Promise<ModelMetadata>,
  choosesModel: boolean,
): Promise<Kept> {
  const selection = await resolveRuntimeModelSelection({
    durability: "live",
    modelMetadata,
    selection: result as PublicAgentDynamicModelResult,
  });
  if (!choosesModel && selection.reference.credentialed === true) {
    throw new Error(
      'A dynamic "compaction.model" cannot return a defineModel value because the summary call cannot open a sign-in.',
    );
  }
  const live =
    selection.model === undefined ||
    (!isMockModel(selection.model) && shouldMockAuthoredRuntimeModels())
      ? undefined
      : selection;
  const value: ModelSlotValue = { reference: selection.reference };
  return { live, value: parseJsonValue(value) };
}

export const ChosenModelKey = new ContextKey<{ readonly reference: RuntimeModelReference }>(
  "eve.model",
);

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

export function currentModel(ctx: Pick<ContextReader, "get">): RuntimeModelReference | undefined {
  return (
    ctx.get(ChosenModelKey)?.reference ?? givenModel(ctx) ?? compiledBundleOf(ctx)?.turnAgent.model
  );
}

export function effectiveModelId(ctx: Pick<ContextReader, "get">): string | undefined {
  return currentModel(ctx)?.id;
}

function givenModel(ctx: Pick<ContextReader, "get">): RuntimeModelReference | undefined {
  return (
    ctx.get(AgentSessionRuntimeOverridesKey)?.model ?? ctx.get(DynamicSubagentAgentConfigKey)?.model
  );
}

export function agentModel(bundle: CompiledBundle): Definition | undefined {
  const reference = bundle.turnAgent.model;
  if (reference === undefined) return undefined;
  return {
    contribute: () => ({ model: () => ({ reference }) }),
    id: "eve.model",
    label: "agent.ts#model",
  };
}

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
