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
): Record<string, unknown> {
  const baseGateway =
    base?.gateway !== undefined && typeof base.gateway === "object" && base.gateway !== null
      ? (base.gateway as Record<string, unknown>)
      : undefined;

  const mergedGateway: Record<string, unknown> = {
    ...baseGateway,
    caching: baseGateway?.caching ?? "auto",
  };

  return {
    ...base,
    gateway: mergedGateway,
  };
}

export function applyLastToolCacheBreakpoint(tools: ToolSet, cache: AnthropicCache): ToolSet {
  const entries = Object.entries(tools);
  if (entries.length === 0) {
    return tools;
  }

  const result: Record<string, unknown> = {};
  for (let i = 0; i < entries.length; i++) {
    const [name, tool] = entries[i] as [string, Record<string, unknown>];
    if (i === entries.length - 1) {
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
    if (out[i]?.role === "assistant") {
      mark(i);
      break;
    }
  }

  return out;
}
