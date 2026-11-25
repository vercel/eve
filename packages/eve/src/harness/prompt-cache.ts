import type { ModelMessage, SystemModelMessage, ToolSet } from "ai";

import type { ModelProfile } from "#harness/model-profile.js";

const ANTHROPIC_CACHE_MARKERS = Object.freeze({
  "5m": Object.freeze({
    anthropic: Object.freeze({ cacheControl: Object.freeze({ type: "ephemeral" }) }),
    bedrock: Object.freeze({ cachePoint: Object.freeze({ type: "default" }) }),
  }),
  "1h": Object.freeze({
    anthropic: Object.freeze({ cacheControl: Object.freeze({ type: "ephemeral", ttl: "1h" }) }),
    bedrock: Object.freeze({ cachePoint: Object.freeze({ type: "default", ttl: "1h" }) }),
  }),
});

type AnthropicCache = NonNullable<ModelProfile["anthropicCache"]>;

export function mergeGatewayAutoCaching(
  base: Readonly<Record<string, unknown>> | undefined,
  provider: string,
): Record<string, unknown> {
  const baseGateway =
    base?.gateway !== undefined && typeof base.gateway === "object" && base.gateway !== null
      ? (base.gateway as Record<string, unknown>)
      : undefined;

  const caching = baseGateway?.caching ?? "auto";
  const mergedGateway: Record<string, unknown> = { ...baseGateway, caching };
  if (caching === "auto" && provider === "anthropic") {
    mergedGateway.cacheAnchorMessageIndex = baseGateway?.cacheAnchorMessageIndex ?? 0;
  }

  return {
    ...base,
    gateway: mergedGateway,
  };
}

export function omitGatewayAutoCaching(
  providerOptions: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const gateway = providerOptions.gateway;
  if (gateway === null || typeof gateway !== "object" || Array.isArray(gateway)) {
    return { ...providerOptions };
  }
  const { caching, ...rest } = gateway as Record<string, unknown>;
  return { ...providerOptions, gateway: caching === "auto" ? rest : gateway };
}

export function applyLastToolCacheBreakpoint(tools: ToolSet, cache: AnthropicCache): ToolSet {
  const entries = Object.entries(tools);
  if (entries.length === 0) {
    return tools;
  }

  let targetIndex = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const tool = entries[i]?.[1] as Record<string, unknown> | undefined;
    if (tool?.type !== "provider") {
      targetIndex = i;
      break;
    }
  }
  if (targetIndex === -1) {
    return tools;
  }

  const result: Record<string, unknown> = {};
  for (let i = 0; i < entries.length; i++) {
    const [name, tool] = entries[i] as [string, Record<string, unknown>];
    if (i === targetIndex) {
      const existingProviderOptions =
        tool.providerOptions !== undefined && typeof tool.providerOptions === "object"
          ? (tool.providerOptions as Record<string, unknown>)
          : undefined;
      result[name] = {
        ...tool,
        providerOptions: {
          ...existingProviderOptions,
          ...ANTHROPIC_CACHE_MARKERS[cache.ttl],
        },
      };
    } else {
      result[name] = tool;
    }
  }

  return result as ToolSet;
}

export function applySystemCacheBreakpoint(
  instructions: readonly SystemModelMessage[],
  cache: AnthropicCache,
): SystemModelMessage[] {
  if (instructions.length === 0) return [...instructions];

  const result = [...instructions];
  const last = result[result.length - 1]!;
  result[result.length - 1] = {
    ...last,
    providerOptions: {
      ...last.providerOptions,
      ...ANTHROPIC_CACHE_MARKERS[cache.ttl],
    },
  };
  return result;
}

export function applyConversationCacheControl(
  messages: readonly ModelMessage[],
  cache: AnthropicCache,
): ModelMessage[] {
  if (messages.length === 0) {
    return [...messages];
  }

  const out = [...messages];

  const mark = (index: number): void => {
    const message = out[index];
    if (message === undefined) {
      return;
    }
    out[index] = {
      ...message,
      providerOptions: {
        ...message.providerOptions,
        ...ANTHROPIC_CACHE_MARKERS[cache.ttl],
      },
    };
  };

  mark(out.length - 1);

  for (let i = out.length - 2; i >= 0; i--) {
    const candidate = out[i];
    if (candidate?.role === "assistant" && !isReasoningOnlyAssistantMessage(candidate)) {
      mark(i);
      break;
    }
  }

  return out;
}

function isReasoningOnlyAssistantMessage(message: ModelMessage): boolean {
  if (!Array.isArray(message.content) || message.content.length === 0) return false;
  return message.content.every((part) => part.type === "reasoning");
}
