import type { PlatformModels } from "#platform/types.js";
import { resolveGatewayModelCredential } from "#platform/vercel/model-auth/gateway-credential.js";

export const vercelModels: PlatformModels = {
  gatewayCredential: resolveGatewayModelCredential,
};
