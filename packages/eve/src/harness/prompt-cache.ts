import type { LanguageModel, ModelMessage, SystemModelMessage, ToolSet } from "ai";

/**
 * The caching strategy to apply for one harness step.
 */
export type PromptCachePath =
  | { readonly kind: "gateway-auto" }
  | { readonly kind: "anthropic-direct" }
  | { readonly kind: "none" };

/**
 * An explicit author-declared prompt-cache-path override, declared under the
 * eve-owned `providerOptions.eve` namespace on `modelOptions`.
 *
 * Used to force a caching path that cannot be inferred from the resolved
 * model's `provider`/`modelId` alone — for example an AWS Bedrock application
 * inference profile whose opaque id omits the underlying `anthropic` provider
 * family (`modelOptions.providerOptions.eve = { cachePath: "anthropic-direct" }`).
 */
export type PromptCachePathOverride = "anthropic-direct" | "none";

/**
 * The eve-owned namespace inside `modelOptions.providerOptions`. Provider SDKs
 * do not read this key, so eve may use it to carry framework hints (the same
 * role as `providerOptions.gateway.byok`) without leaking into the provider's
 * request payload semantics.
 */
const EVE_PROVIDER_OPTIONS_NAMESPACE = "eve";

/**
 * Reads a strictly-validated prompt-cache-path override out of the model's
 * authored `modelOptions.providerOptions.eve` block. Returns `undefined` when
 * no override is declared. Throws on an unrecognized value so a typo cannot
 * silently fall back to inference.
 */
function readCachePathOverride(
  modelProviderOptions: Readonly<Record<string, unknown>> | undefined,
): PromptCachePathOverride | undefined {
  const eve = modelProviderOptions?.[EVE_PROVIDER_OPTIONS_NAMESPACE];
  if (eve === undefined || eve === null) {
    return undefined;
  }
  if (typeof eve !== "object" || Array.isArray(eve)) {
    return undefined;
  }

  const override = (eve as Record<string, unknown>).cachePath;
  if (override === undefined || override === null) {
    return undefined;
  }
  if (override === "anthropic-direct" || override === "none") {
    return override;
  }

  throw new Error(
    `Unsupported modelOptions.providerOptions.eve.cachePath ${JSON.stringify(override)}. ` +
      `Expected one of "anthropic-direct" or "none".`,
  );
}

/**
 * Cache marker injected on the Anthropic-direct path.
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
 * every Anthropic-direct request regardless of which provider serves it.
 */
export interface AnthropicCacheMarker {
  readonly anthropic: {
    readonly cacheControl: { readonly type: "ephemeral" };
  };
  readonly bedrock: {
    readonly cachePoint: { readonly type: "default" };
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
  bedrock: Object.freeze({
    cachePoint: Object.freeze({ type: "default" as const }),
  }),
});

/**
 * Detects which prompt caching path applies to a resolved model.
 *
 * Runs once per harness step right after `resolveModel()`. An explicit
 * `modelOptions.providerOptions.eve.cachePath` override (read from
 * `modelProviderOptions`, the active model reference's `providerOptions`)
 * takes precedence over inference; when no override is declared the path is
 * inferred from the resolved model's provider name and model id.
 */
export function detectPromptCachePath(
  model: LanguageModel,
  modelProviderOptions?: Readonly<Record<string, unknown>>,
): PromptCachePath {
  const override = readCachePathOverride(modelProviderOptions);
  if (override !== undefined) {
    return { kind: override };
  }

  if (typeof model === "string") {
    return { kind: "gateway-auto" };
  }

  const providerName = typeof model.provider === "string" ? model.provider.toLowerCase() : "";
  if (providerName.includes("anthropic")) {
    return { kind: "anthropic-direct" };
  }

  // The standard `@ai-sdk/amazon-bedrock` Converse provider reports its
  // provider as `amazon-bedrock` and carries the Anthropic identity in the
  // model id (e.g. `anthropic.claude-3-5-sonnet-20241022-v2:0`). Application
  // inference profile ids can be opaque and omit that family name; those need
  // the explicit `eve.cachePath` override above rather than id substring
  // inference.
  const modelId = typeof model.modelId === "string" ? model.modelId.toLowerCase() : "";
  if (providerName.includes("bedrock") && modelId.includes("anthropic")) {
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
 */
export function applyConversationCacheControl(
  messages: readonly ModelMessage[],
  marker: AnthropicCacheMarker,
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
        ...marker,
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
