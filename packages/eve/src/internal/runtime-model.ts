import type { LanguageModel } from "ai";

/**
 * Formats an authored agent model reference as an AI Gateway model id.
 *
 * Handles both authored shapes:
 * - A `string` is treated as an already-formatted Gateway id.
 * - A `LanguageModel` instance is formatted as `${provider}/${modelId}`.
 *
 * Some providers expose `provider` as a dotted sub-path (e.g. `anthropic.messages`,
 * `openai.responses`) to disambiguate request shapes. The Gateway routes on the
 * top-level provider only, so any segments after the first dot are dropped.
 */
export function formatLanguageModelGatewayId(model: string | LanguageModel): string {
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
