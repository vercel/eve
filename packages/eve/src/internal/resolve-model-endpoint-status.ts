import type { ModelRouting } from "#shared/agent-definition.js";
import type { ModelEndpointStatus } from "#shared/model-endpoint-status.js";

/**
 * Presence of the two gateway credentials, read from wherever the caller can
 * observe them: the running server's `process.env` (runtime-authoritative) or
 * an app's `.env` files (dev/setup-time). Only meaningful for gateway routing.
 */
export interface GatewayCredentialPresence {
  /** `AI_GATEWAY_API_KEY` is set. */
  readonly apiKey: boolean;
  /** A Vercel OIDC token is available (`VERCEL_OIDC_TOKEN` or a linked project). */
  readonly oidc: boolean;
}

/**
 * Composes the build-time {@link ModelRouting} with runtime credential presence
 * into the consumer-facing {@link ModelEndpointStatus}.
 *
 * Credentials matter only for gateway routing; an external endpoint makes no
 * connectedness claim. `api-key` outranks `oidc` to match the AI SDK gateway
 * provider, which uses `AI_GATEWAY_API_KEY` when present and otherwise the OIDC
 * token.
 */
export function resolveModelEndpointStatus(
  routing: ModelRouting,
  credentials: GatewayCredentialPresence,
): ModelEndpointStatus {
  if (routing.kind === "external") {
    return { kind: "external", provider: routing.provider };
  }
  if (credentials.apiKey) {
    return { kind: "gateway", connected: true, credential: "api-key" };
  }
  if (credentials.oidc) {
    return { kind: "gateway", connected: true, credential: "oidc" };
  }
  return { kind: "gateway", connected: false };
}
