import { isAgentReasoningDefinition, isRuntimeLanguageModel } from "#internal/runtime-model.js";
import type {
  PublicAgentDynamicModelResult,
  PublicAgentModelSelectionDefinition,
  PublicAgentStaticModelDefinition,
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
  | (PublicAgentModelSelectionDefinition & { readonly description: string });

/** Model options by key. */
export type ModelOptions = Readonly<Record<string, ModelOption>>;

/** One option after validation: its key, its description, and the model it selects. */
export interface NormalizedModelOption {
  readonly description: string;
  readonly key: string;
  readonly selection: PublicAgentDynamicModelResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStaticModel(value: unknown): value is PublicAgentStaticModelDefinition {
  return typeof value === "string" ? value.trim().length > 0 : isRuntimeLanguageModel(value);
}

/** Whether the value is a model ID or instance, or a valid model selection. */
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

/** Whether the value is a valid {@link ModelOption}. */
export function isModelOption(option: unknown): option is ModelOption {
  return typeof option === "string"
    ? option.trim().length > 0
    : isRecord(option) &&
        typeof option.description === "string" &&
        option.description.trim().length > 0 &&
        isModelSelection({ ...option, description: undefined });
}

/** Whether the value is a record of valid {@link ModelOption}s. */
export function isModelOptions(value: unknown): value is ModelOptions {
  return isRecord(value) && Object.values(value).every(isModelOption);
}

/** A selection with only a model is the model itself. */
export function normalizeModelSelection(
  selection: ModelOptionSelection,
): PublicAgentDynamicModelResult {
  if (typeof selection === "string" || isRuntimeLanguageModel(selection)) return selection;
  const { model, ...settings } = selection;
  return Object.values(settings).every((value) => value === undefined) ? model : selection;
}

/** Each option's key, description, and selection, in authored order. Validate options first. */
export function normalizeModelOptions(options: ModelOptions): NormalizedModelOption[] {
  return Object.entries(options).map(([key, option]) => {
    if (typeof option === "string") return { description: option, key, selection: key };
    const { description, ...selection } = option;
    return { description, key, selection: normalizeModelSelection(selection) };
  });
}

/** The model of a selection: an AI Gateway model ID or a live model. */
export function selectionModel(selection: ModelOptionSelection): PublicAgentStaticModelDefinition {
  return typeof selection === "string" || isRuntimeLanguageModel(selection)
    ? selection
    : selection.model;
}

/** A selection's model, as a log label. */
export function selectionLogIdentity(selection: ModelOptionSelection): string {
  const model = selectionModel(selection);
  return typeof model === "string" ? model : `${model.provider}/${model.modelId}`;
}
