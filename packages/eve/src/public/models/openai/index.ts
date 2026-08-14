import type { LanguageModel } from "ai";
import { DEFAULT_CHATGPT_MODEL_ID, normalizeChatGptModelId } from "#shared/chatgpt-model.js";
import { createCodexSubscriptionModel } from "./chatgpt/model.js";

/**
 * Creates a language model billed to the local ChatGPT subscription instead
 * of an API key, served through the Codex backend the `codex login` flow
 * authorizes.
 *
 * Defaults to `gpt-5.6-sol`. Pass a bare OpenAI model slug or an
 * `openai/`-prefixed id to override it; the Codex backend serves OpenAI models
 * only, so any other provider-qualified id is rejected. Model availability is
 * enforced by the Codex backend per account at call time, not at compile time.
 *
 * Credentials are read from the Codex CLI login on the machine the agent
 * runs on, so this model works in local dev and fails in a deployment.
 * Branch on environment for production, and set `modelContextWindowTokens`
 * because Codex models carry no AI Gateway metadata:
 *
 * ```ts
 * export default defineAgent({
 *   model:
 *     process.env.NODE_ENV === "production"
 *       ? "anthropic/claude-sonnet-4.6"
 *       : chatgpt(),
 *   modelContextWindowTokens: 200_000,
 * });
 * ```
 */
export function chatgpt(model = DEFAULT_CHATGPT_MODEL_ID): LanguageModel {
  const slug = normalizeChatGptModelId(model);
  if (slug === undefined && model.trim().replace(/^openai\//u, "").length === 0) {
    throw new Error('Expected chatgpt "model" to name an OpenAI model, for example "gpt-5.6-sol".');
  }

  if (slug === undefined) {
    throw new Error(
      `chatgpt serves OpenAI models through the local ChatGPT login; received "${model}".`,
    );
  }

  return createCodexSubscriptionModel({ model: slug });
}

/** @deprecated Use {@link chatgpt}. */
export const experimental_chatgpt = chatgpt;
