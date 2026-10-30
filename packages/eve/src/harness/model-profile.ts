import type { LanguageModel } from "ai";

import type {
  AgentPromptCacheDefinition,
  AnthropicPromptCacheTtl,
} from "#shared/agent-definition.js";

/**
 * What eve assumes about the model serving one call. Every decision that shapes a request for
 * its provider reads this record, so a step and its compaction agree about the model.
 */
export interface ModelProfile {
  /** Routed through AI Gateway, which caches automatically and serves Gateway tools. */
  readonly gateway: boolean;
  /**
   * Who serves the request: a Gateway id's vendor (`openai/gpt-5` → `openai`), which Gateway
   * translates for whichever host it routes to, otherwise the SDK provider's top-level name
   * (`anthropic`, `amazon-bedrock`, `vertex`, `azure`). It names the host, not the model family:
   * hosts of the same family accept different things (Bedrock and Vertex reject Anthropic's web
   * search tool), so a capability a host shares with its family gets its own flag, like
   * `anthropicCache`.
   */
  readonly provider: string;
  /** Takes Anthropic prompt-cache breakpoints, which live for `ttl`. */
  readonly anthropicCache: { readonly ttl: AnthropicPromptCacheTtl } | undefined;
  /** Chat Completions APIs can't carry files in tool results, so they move to user messages. */
  readonly filesOutsideToolResults: boolean;
  /**
   * A Gemini model older than Gemini 3, which can't combine Google Search with function tools:
   * the request keeps the search and drops every other tool.
   */
  readonly googleSearchDropsTools: boolean;
}

/**
 * `promptCache` is the model's authored `modelOptions.promptCache`. It names the cache protocol
 * of a model whose provider and id don't, such as a Bedrock application inference profile.
 */
export function resolveModelProfile(
  model: LanguageModel,
  promptCache?: AgentPromptCacheDefinition,
): ModelProfile {
  const provider = typeof model === "string" ? "gateway" : lowerCaseOrEmpty(model.provider);
  const modelId = typeof model === "string" ? model : lowerCaseOrEmpty(model.modelId);
  const topLevelProvider = provider.split(".")[0]!;
  if (topLevelProvider === "gateway") {
    return {
      anthropicCache: undefined,
      filesOutsideToolResults: false,
      gateway: true,
      googleSearchDropsTools: PRE_GEMINI_3_MODEL.test(modelId),
      provider: modelId.split("/")[0]!,
    };
  }
  // The Bedrock Converse provider reports `amazon-bedrock` and carries the Anthropic identity in
  // the model id (`anthropic.claude-…`).
  const anthropic =
    promptCache?.anthropic !== undefined ||
    provider.includes("anthropic") ||
    (provider.includes("bedrock") && modelId.includes("anthropic"));
  return {
    anthropicCache: anthropic ? { ttl: promptCache?.anthropic?.ttl ?? "5m" } : undefined,
    filesOutsideToolResults: provider.endsWith(".chat"),
    gateway: false,
    googleSearchDropsTools: PRE_GEMINI_3_MODEL.test(modelId),
    provider: topLevelProvider,
  };
}

// Mirrors the Gemini generations `@ai-sdk/google` treats as pre-Gemini 3.
const PRE_GEMINI_3_MODEL =
  /(^|\/)gemini-(?:[12](?:[.-]|$)|pro(?:-vision)?$|robotics-er-1\.5(?:[.-]|$))/i;

/** A test double may omit `provider` or `modelId`; it reads as a direct model with no known provider. */
function lowerCaseOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}
