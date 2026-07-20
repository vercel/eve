import { anyOf, messageMatches, nameIs, type SemanticErrorRule } from "../rule.js";

/**
 * Error class names come from `@ai-sdk/provider` (`AI_LoadAPIKeyError`,
 * `AI_UnsupportedFunctionalityError`, …). The AI SDK also surfaces bare
 * `LoadAPIKeyError` names from provider adapters, so both spellings match.
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
    message:
      "The model provider could not load an API key. Export the provider's API key environment variable (for example `AI_GATEWAY_API_KEY` or `OPENAI_API_KEY`) and try again.",
  },
  {
    id: "model-capability-unsupported",
    name: "Model capability not supported",
    tags: ["model-provider"],
    when: nameIs("AI_UnsupportedFunctionalityError"),
    message:
      "The selected model does not support a capability this agent uses (a tool type, modality, or feature). Remove the unsupported tool or switch to a model that supports it.",
  },
];
