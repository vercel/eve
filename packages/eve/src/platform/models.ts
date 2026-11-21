import type { DevelopmentModelCredential } from "#internal/model-auth/development-broker-protocol.js";
import { platformContext } from "#platform/context.js";
import { hostService } from "#platform/services.js";
import { resolveGatewayModelCredential } from "#platform/vercel/model-auth/gateway-credential.js";

export function gatewayCredential(
  ...args: [rejectedToken?: string]
): Promise<DevelopmentModelCredential> {
  const modelCredentials = hostService(platformContext(), "modelCredentials", () => ({
    resolve: resolveGatewayModelCredential,
  }));
  if (modelCredentials === undefined) {
    return Promise.reject(
      new Error(
        "The installed eve host provides no model credentials. Configure the model with an AI Gateway API key, or add modelCredentials to the host's services.",
      ),
    );
  }
  return modelCredentials.resolve(...args);
}
