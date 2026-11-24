import type { LanguageModel } from "ai";

import type {
  AgentPromptCacheDefinition,
  AnthropicPromptCacheTtl,
} from "#shared/agent-definition.js";

export interface ModelProfile {
  readonly gateway: boolean;
  readonly provider: string;
  readonly anthropicCache: { readonly ttl: AnthropicPromptCacheTtl } | undefined;
  readonly filesOutsideToolResults: boolean;
  readonly googleSearchDropsTools: boolean;
}

export function modelIdentity(model: LanguageModel): {
  readonly provider: string;
  readonly modelId: string;
} {
  return typeof model === "string"
    ? { provider: "gateway", modelId: model }
    : { provider: model.provider, modelId: model.modelId };
}

export function resolveModelProfile(
  model: LanguageModel,
  promptCache?: AgentPromptCacheDefinition,
): ModelProfile {
  const provider = typeof model === "string" ? "gateway" : lowerCaseOrEmpty(model.provider);
  const modelId = typeof model === "string" ? model : lowerCaseOrEmpty(model.modelId);
  const topLevelProvider = provider.split(".")[0]!;
  if (topLevelProvider === "gateway") {
    const vendor = modelId.split("/")[0]!;
    const oneHour = vendor === "anthropic" && promptCache?.anthropic?.ttl === "1h";
    return {
      anthropicCache: oneHour ? { ttl: "1h" } : undefined,
      filesOutsideToolResults: false,
      gateway: true,
      googleSearchDropsTools: PRE_GEMINI_3_MODEL.test(modelId),
      provider: vendor,
    };
  }
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

const PRE_GEMINI_3_MODEL =
  /(^|\/)gemini-(?:[12](?:[.-]|$)|pro(?:-vision)?$|robotics-er-1\.5(?:[.-]|$))/i;

function lowerCaseOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}
