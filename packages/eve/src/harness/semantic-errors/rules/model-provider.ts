import {
  allOf,
  anyOf,
  codeIs,
  messageMatches,
  nameIs,
  type SemanticErrorRule,
  statusCodeIs,
} from "../rule.js";

/**
 * A provider's rejection of a request longer than the model's context window. Anthropic says
 * "prompt is too long" or "exceed context limit"; Bedrock says "Input is too long"; OpenAI says
 * "maximum context length" (Chat Completions) or "exceeds the context window" (Responses); Gemini
 * says "input token count ... exceeds the maximum". AI Gateway relays the upstream message. The
 * prose only counts on a 400/413 rejection, so another error that quotes it isn't misread.
 * OpenAI stream errors carry `code: "context_length_exceeded"` instead.
 *
 * Message prose is a stopgap until the AI SDK classifies this itself (vercel/ai#22461).
 */
export const isContextOverflowLink = anyOf(
  codeIs("context_length_exceeded"),
  allOf(
    statusCodeIs(400, 413),
    messageMatches(
      /prompt is too long|exceed context limit|input is too long|maximum context length|exceeds the context window|input token count.*exceeds the maximum/i,
    ),
  ),
);

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
    id: "model-context-overflow",
    name: "Model context window exceeded",
    tags: ["model-provider"],
    when: isContextOverflowLink,
    message: "The request exceeds the model's context window.",
    hint: "eve compacts and retries once on this error. If it persists, lower `compaction.thresholdPercent` in `agent.ts` so compaction runs sooner, or start a new session.",
  },
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
    id: "model-response-content-filtered",
    name: "Model response filtered",
    tags: ["model-provider", "recoverable"],
    when: nameIs("ContentFilteredModelResponseError"),
    message: "The model provider filtered this response.",
    hint: "Review the request and its context against your model provider's content policy.",
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
