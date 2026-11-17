import { isAgentReasoningDefinition, isRuntimeLanguageModel } from "#internal/runtime-model.js";
import { isModelDefinition } from "#models/definition.js";
import type {
  PublicAgentDynamicModelResult,
  PublicAgentModelSelectionDefinition,
  PublicAgentTurnModelDefinition,
} from "#shared/agent-definition.js";

/** A model ID or instance, or a selection with model-specific settings. */
export type ModelOptionSelection = PublicAgentDynamicModelResult;

/**
 * One option in a model option record, such as `auto({ options })` or `agent({ models })`.
 * A string is the option's description, and the option's key is its AI Gateway model ID.
 * An object holds the model, which can be a live AI SDK model, with its description.
 */
export type ModelOption =
  | string
  | (PublicAgentModelSelectionDefinition<PublicAgentTurnModelDefinition> & {
      readonly description: string;
    });

/** Model options by key. */
export type ModelOptions = Readonly<Record<string, ModelOption>>;

export interface NormalizedModelOption {
  readonly description: string;
  readonly key: string;
  readonly selection: PublicAgentDynamicModelResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStaticModel(value: unknown): value is PublicAgentTurnModelDefinition {
  return typeof value === "string"
    ? value.trim().length > 0
    : isRuntimeLanguageModel(value) || isModelDefinition(value);
}

export function isModelSelection(value: unknown): value is ModelOptionSelection {
  return (
    isStaticModel(value) ||
    (isRecord(value) &&
      isStaticModel(value.model) &&
      (value.reasoning === undefined || isAgentReasoningDefinition(value.reasoning)) &&
      (value.modelContextWindowTokens === undefined ||
        (Number.isInteger(value.modelContextWindowTokens) &&
          (value.modelContextWindowTokens as number) > 0)) &&
      (value.modelOptions === undefined || isRecord(value.modelOptions)))
  );
}

export function isModelOption(option: unknown): option is ModelOption {
  return typeof option === "string"
    ? option.trim().length > 0
    : isRecord(option) &&
        typeof option.description === "string" &&
        option.description.trim().length > 0 &&
        isModelSelection({ ...option, description: undefined });
}

export function isModelOptions(value: unknown): value is ModelOptions {
  return isRecord(value) && Object.values(value).every(isModelOption);
}

export function normalizeModelSelection(
  selection: ModelOptionSelection,
): PublicAgentDynamicModelResult {
  if (!isSelectionObject(selection)) return selection;
  const { model, ...settings } = selection;
  return Object.values(settings).every((value) => value === undefined) ? model : selection;
}

export function normalizeModelOptions(options: ModelOptions): NormalizedModelOption[] {
  return Object.entries(options).map(([key, option]) => {
    if (typeof option === "string") return { description: option, key, selection: key };
    const { description, ...selection } = option;
    return { description, key, selection: normalizeModelSelection(selection) };
  });
}

export function selectionModel(selection: ModelOptionSelection): PublicAgentTurnModelDefinition {
  return isSelectionObject(selection) ? selection.model : selection;
}

function isSelectionObject(
  selection: ModelOptionSelection,
): selection is PublicAgentModelSelectionDefinition<PublicAgentTurnModelDefinition> {
  return (
    typeof selection !== "string" &&
    !isRuntimeLanguageModel(selection) &&
    !isModelDefinition(selection)
  );
}

export function selectionLogIdentity(selection: ModelOptionSelection): string {
  const model = selectionModel(selection);
  if (typeof model === "string") return model;
  return isModelDefinition(model) ? model.id : `${model.provider}/${model.modelId}`;
}
