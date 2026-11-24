import type { DevelopmentModelCredential } from "#internal/model-auth/development-broker-protocol.js";
import type { Entities } from "#platform/entities.js";
import { resolveGatewayModelCredential } from "#platform/vercel/model-auth/gateway-credential.js";
import { vercelNetwork } from "#platform/vercel/network.js";

export function gatewayCredential(
  platform: Entities,
  ...args: [rejectedToken?: string]
): Promise<DevelopmentModelCredential> {
  const modelCredentials = platform.models;
  if (modelCredentials === undefined) {
    return Promise.reject(
      new Error(
        "The installed eve host provides no model credentials. Configure the model with an AI Gateway API key, or add `models` to the platform.",
      ),
    );
  }
  return modelCredentials.resolve(...args);
}

export function developmentGatewayCredential(
  rejectedToken?: string,
): Promise<DevelopmentModelCredential> {
  return resolveGatewayModelCredential(vercelNetwork, rejectedToken);
}
