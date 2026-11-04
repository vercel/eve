import type { LanguageModel } from "ai";
import type { AgentReasoningDefinition, EveLanguageModel } from "#shared/agent-definition.js";

/**
 * Formats an authored agent model reference as an AI Gateway model id.
 *
 * Handles both authored shapes:
 * - A `string` is treated as an already-formatted Gateway id.
 * - An `EveLanguageModel` instance is formatted as `${provider}/${modelId}`.
 *
 * Some providers expose `provider` as a dotted sub-path (e.g. `anthropic.messages`,
 * `openai.responses`) to disambiguate request shapes. The Gateway routes on the
 * top-level provider only, so any segments after the first dot are dropped.
 */
export function formatLanguageModelGatewayId(model: string | EveLanguageModel): string {
  if (typeof model === "string") {
    return model;
  }
  const provider = model.provider.split(".")[0];
  /*
   * Anthropic's own model IDs use a hyphen between the major and minor version
   * (e.g. `claude-opus-4-7`), but the Gateway routes on a dotted form
   * (`claude-opus-4.7`), so we rewrite that one separator.
   */
  const modelId = model.modelId.replace(/^(claude-[a-z]+-\d+)-(\d+)$/, "$1.$2");
  return `${provider}/${modelId}`;
}

export function isRuntimeLanguageModel(value: unknown): value is EveLanguageModel {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const model = value as {
    specificationVersion?: unknown;
    provider?: unknown;
    modelId?: unknown;
    doGenerate?: unknown;
    doStream?: unknown;
  };

  return (
    (model.specificationVersion === "v2" ||
      model.specificationVersion === "v3" ||
      model.specificationVersion === "v4") &&
    typeof model.provider === "string" &&
    typeof model.modelId === "string" &&
    typeof model.doGenerate === "function" &&
    typeof model.doStream === "function"
  );
}

/**
 * Hands an authored model to the AI SDK. `EveLanguageModel` keeps call options opaque so the
 * public surface does not re-export AI SDK types; every value it describes is an AI SDK model.
 */
export function toAiSdkLanguageModel(model: string | EveLanguageModel): LanguageModel {
  return model as LanguageModel;
}

export function isAgentReasoningDefinition(value: unknown): value is AgentReasoningDefinition {
  return (
    typeof value === "string" &&
    ["provider-default", "none", "minimal", "low", "medium", "high", "xhigh"].includes(value)
  );
}
