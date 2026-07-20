import { anyOf, messageMatches, nameIs, type SemanticErrorRule } from "../rule.js";

/**
 * Discriminators verified against the vendored `@ai-sdk/provider` /
 * `@ai-sdk/provider-utils` source: the error classes set
 * `name = "AI_LoadAPIKeyError"` / `"AI_UnsupportedFunctionalityError"`,
 * and `loadApiKey` builds its message as
 * `"<provider> API key is missing. Pass it using the …"`. The bare
 * `LoadAPIKeyError` spelling is defensive, for provider adapters that
 * rethrow under the unprefixed class name.
 */
export const MODEL_PROVIDER_RULES: readonly SemanticErrorRule[] = [
  {
    id: "model-provider-api-key-missing",
    name: "Model provider API key missing",
    tags: ["model-provider", "config"],
    when: anyOf(
      nameIs("LoadAPIKeyError", "AI_LoadAPIKeyError"),
      messageMatches(/API key is missing/i),
    ),
    message: "The model provider could not load an API key.",
    hint: "Export the provider's API key environment variable (for example `AI_GATEWAY_API_KEY` or `OPENAI_API_KEY`) and try again.",
  },
  {
    // eve's own EmptyModelResponseError (harness/model-call-error.ts); its
    // message is authored for end users, so it passes through. The
    // model-call classifier special-cases this shape *before* consulting
    // tags — a same-hooks retry would read a stale step result.
    id: "empty-model-response",
    name: "Empty model response",
    tags: ["model-provider", "transient"],
    when: nameIs("EmptyModelResponseError"),
    message: (link) => link.message,
  },
  {
    id: "model-capability-unsupported",
    name: "Model capability not supported",
    tags: ["model-provider"],
    when: nameIs("AI_UnsupportedFunctionalityError"),
    message:
      "The selected model does not support a capability this agent uses (a tool type, modality, or feature).",
    hint: "Remove the unsupported tool or switch to a model that supports it.",
  },
];
