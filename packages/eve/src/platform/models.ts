import type { DevelopmentModelCredential } from "#internal/model-auth/development-broker-protocol.js";
import { platformContext, type PlatformTarget } from "#platform/context.js";
import { resolveGatewayModelCredential } from "#platform/vercel/model-auth/gateway-credential.js";

export type GatewayCredentialResolver = (
  rejectedToken?: string,
) => Promise<DevelopmentModelCredential>;

const IMPLEMENTATIONS: Record<PlatformTarget, GatewayCredentialResolver> = {
  vercel: resolveGatewayModelCredential,
};

export function gatewayCredential(
  ...args: Parameters<GatewayCredentialResolver>
): Promise<DevelopmentModelCredential> {
  return IMPLEMENTATIONS[platformContext().target](...args);
}
