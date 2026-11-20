import { platformContext, type PlatformTarget } from "#platform/context.js";
import { resolveGatewayModelCredential } from "#platform/vercel/model-auth/gateway-credential.js";

const IMPLEMENTATIONS: Record<PlatformTarget, typeof resolveGatewayModelCredential> = {
  vercel: resolveGatewayModelCredential,
};

export function gatewayCredential(
  ...args: Parameters<typeof resolveGatewayModelCredential>
): ReturnType<typeof resolveGatewayModelCredential> {
  return IMPLEMENTATIONS[platformContext().target](...args);
}
