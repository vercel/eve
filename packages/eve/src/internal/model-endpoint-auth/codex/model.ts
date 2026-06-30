import type { LanguageModel } from "ai";

import { createOpenAI } from "#compiled/@ai-sdk/openai/index.js";
import {
  createCodexFetch,
  type CodexTransportOptions,
} from "#internal/model-endpoint-auth/codex/transport.js";

export {
  readCodexAuthState,
  type CodexAuthState,
} from "#internal/model-endpoint-auth/codex/auth.js";

const CODEX_LOCAL_AUTH_API_KEY = "codex-local-auth";

/** Configures the Codex model selected by the local Codex login. */
export interface CodexModelOptions {
  /** Codex model ID passed to the OpenAI Responses API, for example `gpt-5.2-codex`. */
  readonly model: string;
}

/** Creates an AI SDK model backed by the local Codex login in `~/.codex`. */
export function experimentalCodex(input: CodexModelOptions): LanguageModel {
  return createCodexSubscriptionModel(input);
}

export const experimental_codex = experimentalCodex;

// Test seam for the direct Codex transport boundary.
export function createCodexSubscriptionModel(
  input: CodexModelOptions,
  options: CodexTransportOptions = {},
): LanguageModel {
  const model = input.model.trim();
  if (model.length === 0) {
    throw new Error('Expected "model" to name a Codex model.');
  }

  return createOpenAI({
    apiKey: CODEX_LOCAL_AUTH_API_KEY,
    fetch: createCodexFetch(options),
    name: "codex",
  }).responses(model);
}
