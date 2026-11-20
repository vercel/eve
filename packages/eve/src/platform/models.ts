import type { DevelopmentModelCredential } from "#internal/model-auth/development-broker-protocol.js";
import { platformHook } from "#platform/capabilities.js";
import { platformContext } from "#platform/context.js";
import { resolveGatewayModelCredential } from "#platform/vercel/model-auth/gateway-credential.js";

export type GatewayCredentialResolver = (
  rejectedToken?: string,
) => Promise<DevelopmentModelCredential>;

export function gatewayCredential(
  ...args: Parameters<GatewayCredentialResolver>
): Promise<DevelopmentModelCredential> {
  const modelCredentials = platformHook(
    platformContext(),
    "modelCredentials",
    resolveGatewayModelCredential,
  );
  if (modelCredentials === undefined) {
    return Promise.reject(
      new Error(
        "The installed eve host provides no model credentials. Configure the model with an AI Gateway API key, or declare modelCredentials in the host's capabilities and add a modelCredentials hook.",
      ),
    );
  }
  return modelCredentials(...args);
}
