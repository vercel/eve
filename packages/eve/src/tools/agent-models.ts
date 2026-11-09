import {
  isModelOptions,
  normalizeModelOptions,
  type ModelOptions,
  type NormalizedModelOption,
} from "#models/options.js";

const AGENT_TOOL_MODELS = Symbol.for("eve.agent-tool-models");

type AgentToolModelsCarrier = {
  readonly [AGENT_TOOL_MODELS]?: ReadonlyMap<string, NormalizedModelOption>;
};

/** Validates `agent({ models })` and returns each option by key, in authored order. */
export function parseAgentToolModels(models: unknown): ReadonlyMap<string, NormalizedModelOption> {
  if (!isModelOptions(models)) {
    throw new TypeError(
      "agent({ models }) requires a record of description strings, keyed by AI Gateway model ID, or { model, description, reasoning?, modelContextWindowTokens?, modelOptions? } entries.",
    );
  }
  const options = normalizeModelOptions(models as ModelOptions);
  if (options.length === 0) {
    throw new TypeError("agent({ models }) requires at least one model.");
  }
  return new Map(options.map((option) => [option.key, option]));
}

/** Keeps the parsed models on the tool definition, where the runtime reads them by key. */
export function attachAgentToolModels<TDefinition extends object>(
  definition: TDefinition,
  models: ReadonlyMap<string, NormalizedModelOption>,
): TDefinition {
  Object.defineProperty(definition, AGENT_TOOL_MODELS, {
    configurable: false,
    enumerable: false,
    value: models,
    writable: false,
  });
  return definition;
}

/** The models an `agent({ models })` definition offers, or `undefined` for any other value. */
export function readAgentToolModels(
  value: unknown,
): ReadonlyMap<string, NormalizedModelOption> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as AgentToolModelsCarrier)[AGENT_TOOL_MODELS];
}
