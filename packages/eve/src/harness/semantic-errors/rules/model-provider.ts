import {
  allOf,
  anyOf,
  codeIs,
  messageMatches,
  nameIs,
  type SemanticErrorRule,
  statusCodeIs,
} from "../rule.js";

const isContextOverflowLink = anyOf(
  codeIs("context_length_exceeded"),
  allOf(
    statusCodeIs(400, 413),
    messageMatches(
      /prompt is too long|exceed context limit|input is too long|maximum context length|exceeds the context window|input token count.*exceeds the maximum/i,
    ),
  ),
);

export const MODEL_PROVIDER_RULES: readonly SemanticErrorRule[] = [
  {
    id: "model-context-overflow",
    name: "Model context window exceeded",
    tags: ["model-provider", "recoverable"],
    when: isContextOverflowLink,
    message: "The request exceeds the model's context window.",
    hint: "Send a shorter message or start a new session. If this repeats, lower `compaction.threshold` in `agent.ts` so compaction runs sooner, or shorten the agent's instructions, tools, or memory.",
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
    id: "empty-model-response",
    name: "Empty model response",
    tags: ["model-provider", "transient"],
    when: nameIs("EmptyModelResponseError"),
    message: (link) => link.message,
  },
  {
    id: "model-response-content-filtered",
    name: "Model response filtered",
    tags: ["model-provider", "recoverable", "refused"],
    when: nameIs("ContentFilteredModelResponseError"),
    message: "The model provider filtered this response.",
    hint: "Review the request and its context against your model provider's content policy.",
  },
  {
    id: "model-request-cyber-policy-refused",
    name: "Model request refused",
    tags: ["model-provider", "recoverable", "refused"],
    when: codeIs("cyber_policy"),
    message: "The model provider refused this request for possible cybersecurity risk.",
    hint: "Review the request against your model provider's usage policies.",
  },
  {
    id: "model-request-bio-policy-refused",
    name: "Model request refused",
    tags: ["model-provider", "recoverable", "refused"],
    when: codeIs("bio_policy"),
    message: "The model provider refused this request for possible biological risk.",
    hint: "Review the request against your model provider's usage policies.",
  },
  {
    id: "model-request-prompt-flagged",
    name: "Model request refused",
    tags: ["model-provider", "recoverable", "refused"],
    when: codeIs("invalid_prompt"),
    message: "The model provider flagged this request as potentially violating its usage policy.",
    hint: "Review the request against your model provider's usage policies.",
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
