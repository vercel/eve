import type { LanguageModel } from "ai";

import type { ModelRouting } from "#shared/agent-definition.js";
import type { JsonObject } from "#shared/json.js";

const GATEWAY_PROVIDER = "gateway";

/**
 * Classifies how an authored model value will be routed at runtime, through the
 * Vercel AI Gateway or directly to a provider.
 *
 * A bare string id is *defined* as gateway-routed: that is the AI SDK's default
 * (`globalThis.AI_SDK_DEFAULT_PROVIDER ?? gateway`), and the runtime hands the
 * raw string back to the AI SDK to re-resolve. The compile-time global can
 * differ from the runtime global, so observing an override at build time was
 * unreliable and could make the manifest's routing false — we therefore classify
 * the string directly rather than resolving it through the global.
 *
 * For an instance we read its `provider`. AI SDK model construction is lazy
 * (auth and network happen per request), so this is safe to call at build time
 * with no credentials present. Fails closed for instances: a model without a
 * string `provider` throws rather than silently misclassifying.
 *
 * This answers *where* the model routes, not *whether* the model id is valid.
 * An unknown id still classifies as gateway-routed, which is the correct routing
 * answer. Model-existence is the catalog's concern, not this function's.
 */
export function classifyModelRouting(
  model: string | LanguageModel,
  providerOptions?: Record<string, JsonObject>,
): ModelRouting {
  if (typeof model === "string") {
    const routing: ModelRouting = { kind: "gateway", target: gatewayTarget(model) };
    const byok = readByokProvider(providerOptions);
    if (byok !== undefined) routing.byok = byok;
    return routing;
  }

  if (typeof model.provider !== "string") {
    throw new Error("Cannot classify model routing: the authored model has no string `provider`.");
  }
  const modelId = typeof model.modelId === "string" ? model.modelId : "";
  // Some providers expose a dotted sub-path (e.g. `anthropic.messages`,
  // `gateway.realtime`); routing is decided by the top-level segment only.
  const topLevelProvider = model.provider.split(".")[0]!;

  if (topLevelProvider === GATEWAY_PROVIDER) {
    const routing: ModelRouting = { kind: "gateway", target: gatewayTarget(modelId) };
    const byok = readByokProvider(providerOptions);
    if (byok !== undefined) routing.byok = byok;
    return routing;
  }

  return { kind: "external", provider: topLevelProvider };
}

function gatewayTarget(modelId: string): string {
  return modelId.split("/")[0]!;
}

/**
 * Reads the upstream provider slug from a `providerOptions.gateway.byok` block
 * (the convention eve scaffolds for forwarding a provider key to the gateway).
 * Returns the first provider key, or undefined when no byok block is present.
 */
function readByokProvider(providerOptions?: Record<string, JsonObject>): string | undefined {
  const gatewayOptions = providerOptions?.[GATEWAY_PROVIDER];
  if (
    gatewayOptions === undefined ||
    gatewayOptions === null ||
    typeof gatewayOptions !== "object"
  ) {
    return undefined;
  }
  const byok = (gatewayOptions as Record<string, unknown>).byok;
  if (byok === undefined || byok === null || typeof byok !== "object") {
    return undefined;
  }
  const [provider] = Object.keys(byok as Record<string, unknown>);
  return provider;
}
