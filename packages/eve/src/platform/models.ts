import type { DevelopmentModelCredential } from "#internal/model-auth/development-broker-protocol.js";
import { installedPlatform } from "#platform/context.js";
import { resolveGatewayModelCredential } from "#platform/vercel/model-auth/gateway-credential.js";

export function gatewayCredential(
  ...args: [rejectedToken?: string]
): Promise<DevelopmentModelCredential> {
  const platform = installedPlatform();
  const modelCredentials =
    platform === undefined ? { resolve: resolveGatewayModelCredential } : platform.models;
  if (modelCredentials === undefined) {
    return Promise.reject(
      new Error(
        "The installed eve host provides no model credentials. Configure the model with an AI Gateway API key, or add `models` to the platform.",
      ),
    );
  }
  return modelCredentials.resolve(...args);
}
