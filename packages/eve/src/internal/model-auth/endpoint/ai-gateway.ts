import { getVercelOidcToken } from "#compiled/@vercel/oidc/index.js";
import type { ModelEndpointFactory } from "#internal/model-auth/endpoint/model-endpoint-factory.js";
import type { ModelEndpointStatus } from "#shared/model-endpoint-status.js";

export interface ResolveAiGatewayEndpointStatusOptions {
  readonly env?: Record<string, string | undefined>;
  readonly getOidcToken?: () => Promise<string>;
}

/**
 * The default endpoint: a gateway model id string resolves through the AI
 * SDK global default provider, which routes it via the Vercel AI Gateway.
 * Connectedness means a resolvable gateway credential — `AI_GATEWAY_API_KEY`
 * first, else an OIDC token.
 */
export const aiGatewayEndpoint = {
  createModel: (reference) => reference.id,

  async resolveStatus(
    options: ResolveAiGatewayEndpointStatusOptions = {},
  ): Promise<ModelEndpointStatus> {
    const env = options.env ?? process.env;
    if (hasEnvValue(env.AI_GATEWAY_API_KEY)) {
      return { kind: "gateway", connected: true, credential: "api-key" };
    }

    try {
      await (options.getOidcToken ?? getVercelOidcToken)();
      return { kind: "gateway", connected: true, credential: "oidc" };
    } catch {
      return { kind: "gateway", connected: false };
    }
  },
} satisfies ModelEndpointFactory<ResolveAiGatewayEndpointStatusOptions>;

function hasEnvValue(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}
