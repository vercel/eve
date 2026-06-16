import type { LanguageModel, ModelMessage, SystemModelMessage, ToolSet } from "ai";

/**
 * The caching strategy to apply for one harness step.
 */
export type PromptCachePath =
  | { readonly kind: "gateway-auto" }
  | { readonly kind: "anthropic-direct" }
  | { readonly kind: "none" };

/**
 * Cache marker injected on the Anthropic-direct path.
 *
 * The AI SDK Anthropic provider reads `providerOptions.anthropic.cacheControl`
 * from message, message-part, system-message, and tool objects. The same
 * namespace is used by `@ai-sdk/amazon-bedrock/anthropic` and
 * `@ai-sdk/google-vertex/anthropic`, which both implement the native
 * Anthropic Messages API.
 */
export interface AnthropicCacheMarker {
  readonly anthropic: {
    readonly cacheControl: { readonly type: "ephemeral" };
  };
}

/**
 * Shared frozen marker. All direct-Anthropic breakpoints in the harness share
 * this instance to avoid allocating per-message.
 */
const ANTHROPIC_CACHE_MARKER: AnthropicCacheMarker = Object.freeze({
  anthropic: Object.freeze({
    cacheControl: Object.freeze({ type: "ephemeral" as const }),
  }),
});

/**
 * Detects which prompt caching path applies to a resolved model.
 *
 * Runs once per harness step right after `resolveModel()`.
 */
export function detectPromptCachePath(model: LanguageModel): PromptCachePath {
  if (typeof model === "string") {
    return { kind: "gateway-auto" };
  }

  const providerName = typeof model.provider === "string" ? model.provider.toLowerCase() : "";
  if (providerName.includes("anthropic")) {
    return { kind: "anthropic-direct" };
  }

  return { kind: "none" };
}

/**
 * Returns the shared Anthropic cache marker used on the `anthropic-direct`
 * path. Exposed for unit tests and for the harness wiring layer.
 */
export function getAnthropicCacheMarker(): AnthropicCacheMarker {
  return ANTHROPIC_CACHE_MARKER;
}

/**
 * Returns a new `providerOptions` object with
 * `gateway.caching = "auto"` merged into the existing `gateway` sub-object.
 *
 * Preserves any existing author-provided `gateway` keys (such as
 * `order: ["anthropic", "bedrock"]` load balancing), and leaves an
 * explicit author override on `gateway.caching` untouched so callers can
 * opt out by setting `providerOptions.gateway.caching` to `false` or
 * another value.
 */
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

/**
 * Returns a new ToolSet where the last tool entry carries the Anthropic
 * cache marker on `providerOptions`. Used on the `anthropic-direct` path
 * to place a stable breakpoint at the end of the tools block, caching the
 * full tool definitions across every turn.
 *
 * No-op when `tools` has no entries. Preserves existing `providerOptions`
 * on tools (merges the cache marker in via spread).
 */
export function applyLastToolCacheBreakpoint(
  tools: ToolSet,
  marker: AnthropicCacheMarker,
): ToolSet {
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
          ...marker,
        },
      };
    } else {
      result[name] = tool;
    }
  }

  return result as ToolSet;
}

/**
 * Marks the last system message in an instructions array with the Anthropic
 * cache marker. This creates a cache breakpoint at the end of the system
 * prompt, preserving the system prefix when tools change between steps.
 *
 * When `instructions` is a string or undefined, returns it unchanged —
 * single-string system prompts don't support per-message providerOptions.
 * No-op when the array is empty.
 */
export function applySystemCacheBreakpoint(
  instructions: readonly SystemModelMessage[],
  marker: AnthropicCacheMarker,
): SystemModelMessage[] {
  if (instructions.length === 0) return [...instructions];

  const result = [...instructions];
  const last = result[result.length - 1]!;
  result[result.length - 1] = {
    ...last,
    providerOptions: {
      ...last.providerOptions,
      ...marker,
    },
  };
  return result;
}

/**
 * Walks backward through `messages` and attaches the Anthropic cache marker
 * to the most recent `assistant` and most recent `user` message. Returns a
 * new array; does not mutate the input.
 *
 * This implements the "automatic cache advancement" pattern: each turn the
 * breakpoints move forward, and the prior turn's breakpoints still warm the
 * cache prefix, so the new breakpoints just extend the cached region.
 *
 * Tool-result messages (`role: "tool"`) are intentionally skipped — the
 * adjacent assistant message's cache marker already covers the prefix
 * through any preceding tool results.
 */
export function applyConversationCacheControl(
  messages: readonly ModelMessage[],
  marker: AnthropicCacheMarker,
): ModelMessage[] {
  if (messages.length === 0) {
    return [...messages];
  }

  const out = [...messages];
  let foundAssistant = false;
  let foundUser = false;

  for (let i = out.length - 1; i >= 0 && (!foundAssistant || !foundUser); i--) {
    const message = out[i];
    if (message === undefined) {
      continue;
    }

    if (!foundAssistant && message.role === "assistant") {
      out[i] = {
        ...message,
        providerOptions: {
          ...message.providerOptions,
          ...marker,
        },
      };
      foundAssistant = true;
    } else if (!foundUser && message.role === "user") {
      out[i] = {
        ...message,
        providerOptions: {
          ...message.providerOptions,
          ...marker,
        },
      };
      foundUser = true;
    }
  }

  return out;
}
