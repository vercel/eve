import type { LanguageModel } from "ai";

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
  /** Takes Anthropic prompt-cache breakpoints. */
  readonly anthropicCache: boolean;
  /** Chat Completions APIs can't carry files in tool results, so they move to user messages. */
  readonly filesOutsideToolResults: boolean;
  /**
   * A Gemini model older than Gemini 3, which can't combine Google Search with function tools:
   * the request keeps the search and drops every other tool.
   */
  readonly googleSearchDropsTools: boolean;
}

export function resolveModelProfile(model: LanguageModel): ModelProfile {
  const provider = typeof model === "string" ? "gateway" : lowerCaseOrEmpty(model.provider);
  const modelId = typeof model === "string" ? model : lowerCaseOrEmpty(model.modelId);
  const topLevelProvider = provider.split(".")[0]!;
  if (topLevelProvider === "gateway") {
    return {
      anthropicCache: false,
      filesOutsideToolResults: false,
      gateway: true,
      googleSearchDropsTools: PRE_GEMINI_3_MODEL.test(modelId),
      provider: modelId.split("/")[0]!,
    };
  }
  return {
    // The Bedrock Converse provider reports `amazon-bedrock` and carries the Anthropic identity
    // in the model id (`anthropic.claude-…`).
    anthropicCache:
      provider.includes("anthropic") ||
      (provider.includes("bedrock") && modelId.includes("anthropic")),
    filesOutsideToolResults: provider.endsWith(".chat"),
    gateway: false,
    googleSearchDropsTools: PRE_GEMINI_3_MODEL.test(modelId),
    provider: topLevelProvider,
  };
}

// Mirrors the Gemini generations `@ai-sdk/google` treats as pre-Gemini 3.
const PRE_GEMINI_3_MODEL = /(^|\/)gemini-(?:[12](?:[.-]|$)|pro(?:-vision)?$)/i;

/** A test double may omit `provider` or `modelId`; it reads as a direct model with no known provider. */
function lowerCaseOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}
