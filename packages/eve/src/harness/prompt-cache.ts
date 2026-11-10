import type { ModelMessage, SystemModelMessage, ToolSet } from "ai";

import type { ModelProfile } from "#harness/model-profile.js";

/**
 * Cache marker for models that take Anthropic prompt-cache breakpoints.
 *
 * The marker carries two provider namespaces because Anthropic models are
 * reachable through providers that read different provider-options keys:
 *
 * - `anthropic.cacheControl` — read by the AI SDK Anthropic provider and by
 *   `@ai-sdk/amazon-bedrock/anthropic` and `@ai-sdk/google-vertex/anthropic`,
 *   which implement the native Anthropic Messages API.
 * - `bedrock.cachePoint` — read by the standard `@ai-sdk/amazon-bedrock`
 *   Converse provider, which does not understand `anthropic.cacheControl`.
 *
 * A provider ignores namespaces it does not own, so carrying both is safe on
 * every request regardless of which provider serves it.
 *
 * Anthropic rejects a 1-hour breakpoint that follows a 5-minute one, so the tools
 * and system breakpoints, which come first in the request, never use a shorter TTL
 * than the conversation breakpoints after them. The 5-minute marker omits the TTL,
 * which is the providers' default.
 */
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

/**
 * Returns a new `providerOptions` object with
 * `gateway.caching = "auto"` merged into the existing `gateway` sub-object.
 *
 * Preserves any existing author-provided `gateway` keys (such as
 * `order: ["anthropic", "bedrock"]` load balancing), and leaves an
 * explicit author override on `gateway.caching` untouched so callers can
 * opt out by setting `providerOptions.gateway.caching` to `false` or
 * another value.
 *
 * For Anthropic models under automatic caching it also anchors a breakpoint
 * on the system prompt (`gateway.cacheAnchorMessageIndex: 0`). Gateway's
 * automatic breakpoints sit on the latest messages, and Anthropic looks back
 * only 20 blocks from a breakpoint, so in a session with history they never
 * reach the system prompt: a resumed session whose cache expired rewrites the
 * whole prefix even when another session just cached the same one.
 */
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

/**
 * Returns a new ToolSet where the last tool entry carries the Anthropic
 * cache marker on `providerOptions`. Used for Anthropic-cache models
 * to place a stable breakpoint at the end of the tools block, caching the
 * full tool definitions across every turn.
 *
 * No-op when `tools` has no entries. Preserves existing `providerOptions`
 * on tools (merges the cache marker in via spread).
 */
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

/**
 * Attaches the Anthropic cache marker to the last message in `messages`
 * (whatever its role) and, as a stable mid-history anchor, to the most
 * recent `assistant` message before it. Returns a new array; does not
 * mutate the input.
 *
 * The final breakpoint must sit on the very last message so that the
 * newest content — typically a `tool` message carrying fresh tool
 * results — is written to the cache in the same request that pays for
 * it. Placing it any earlier (e.g. on the last assistant message) leaves
 * the trailing tool results outside the cached region: they get billed
 * as uncached input every turn and only enter the cache one request
 * later, capping the effective hit rate near 50%. The AI SDK Anthropic
 * provider maps a message-level marker on a `tool` message to its last
 * tool-result content block.
 *
 * The assistant anchor implements "automatic cache advancement": it
 * guarantees a breakpoint from the prior request survives into the next
 * one, so cache lookups always find the previous prefix even when a step
 * appends more content blocks than Anthropic's backward boundary scan
 * covers.
 *
 * These breakpoints use `conversationTtl`, which is shorter than `ttl` for a Gateway model that
 * caches its system prompt for an hour: the system prompt is shared across sessions and rarely
 * changes, while each conversation prefix is rewritten on every step.
 */
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
        ...ANTHROPIC_CACHE_MARKERS[cache.conversationTtl],
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
