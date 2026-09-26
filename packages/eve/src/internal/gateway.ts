import type { LanguageModel } from "ai";

import { appendPackageUserAgent, withPackageUserAgent } from "#internal/user-agent.js";
import { resolveConversationId } from "#tracing/conversation-context.js";

const GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh";

/** AI Gateway model listing endpoint (OpenAI-compatible `/v1/models`). */
export const AI_GATEWAY_MODELS_URL = `${GATEWAY_BASE_URL}/v1/models`;

/** AI Gateway model catalog endpoint, the richer variant of {@link AI_GATEWAY_MODELS_URL}. */
export const AI_GATEWAY_MODELS_CATALOG_URL = `${GATEWAY_BASE_URL}/v1/models/catalog`;

/**
 * A `fetch` for direct AI Gateway requests that identifies eve via its
 * User-Agent product token — call sites get a decorated transport, not header
 * plumbing. Unlike the Sandbox binding's `getVercelSandboxFetch`, nothing is
 * constructed per call site, so this is a value rather than a factory.
 */
export const vercelGatewayFetch: typeof globalThis.fetch = withPackageUserAgent();

/**
 * Request headers eve attaches for a model's provider, or `undefined` when
 * the provider needs none. Gateway-routed models (bare ids and `gateway.*`
 * instances) get the eve User-Agent product token so AI Gateway can attribute
 * the traffic; direct-provider models get no extra headers.
 */
export function resolveProviderHeaders(model: LanguageModel): Record<string, string> | undefined {
  if (!isGatewayModel(model)) return undefined;
  return Object.fromEntries(appendPackageUserAgent(new Headers()));
}

export function isGatewayModel(model: LanguageModel): boolean {
  return typeof model === "string" || model.provider?.split(".")[0] === "gateway";
}

/** Groups Gateway generations under the same identity used by eve's agent spans. */
export function mergeGatewaySessionId(
  model: LanguageModel,
  providerOptions: Readonly<Record<string, unknown>> | undefined,
  rootSessionId: string,
): Record<string, unknown> | undefined {
  if (!isGatewayModel(model)) return providerOptions;

  const gateway = providerOptions?.gateway;
  const gatewayOptions =
    gateway !== null && typeof gateway === "object" && !Array.isArray(gateway)
      ? (gateway as Record<string, unknown>)
      : undefined;
  if (typeof gatewayOptions?.sessionId === "string" && gatewayOptions.sessionId.trim()) {
    return providerOptions;
  }

  return {
    ...providerOptions,
    gateway: { ...gatewayOptions, sessionId: resolveConversationId(rootSessionId) },
  };
}
