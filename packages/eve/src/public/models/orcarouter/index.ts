import { createOpenAI } from "#compiled/@ai-sdk/openai/index.js";
import type { LanguageModelV4 } from "#compiled/@ai-sdk/provider/index.js";

/** OrcaRouter's OpenAI-compatible API endpoint. */
export const ORCAROUTER_BASE_URL = "https://api.orcarouter.ai/v1";

/** The router model that picks a live model automatically. */
export const DEFAULT_ORCAROUTER_MODEL_ID = "orcarouter/auto";

/** Configures the model served through the OrcaRouter gateway. */
export interface OrcaRouterModelOptions {
  /** API key, read from `ORCAROUTER_API_KEY` by default. */
  readonly apiKey?: string;
  /** Model id in OrcaRouter's `vendor/model` namespace. */
  readonly model?: string;
}

/**
 * Creates a language model served through [OrcaRouter](https://www.orcarouter.ai),
 * an OpenAI-compatible gateway. Defaults to the `orcarouter/auto` router
 * model, which selects a live model automatically; pass any gateway model id
 * (for example `anthropic/claude-sonnet-5`) to pin a specific model.
 *
 * The key is read from `ORCAROUTER_API_KEY` unless passed explicitly.
 */
export function orcarouter(options: OrcaRouterModelOptions = {}): LanguageModelV4 {
  const model = options.model ?? DEFAULT_ORCAROUTER_MODEL_ID;
  if (model.trim().length === 0) {
    throw new Error('Expected orcarouter "model" to name a gateway model id.');
  }

  return createOpenAI({
    baseURL: ORCAROUTER_BASE_URL,
    apiKey: options.apiKey ?? process.env.ORCAROUTER_API_KEY,
    name: "orcarouter",
  }).chat(model);
}
