import type { Network } from "#platform/entities.js";
import { MODEL_CONNECTION_ENV } from "#shared/model-helper.js";
import { resolveModelApiKey } from "#internal/model-auth/api-key.js";
import {
  readVercelCliConnection,
  refreshVercelCliConnection,
} from "#platform/vercel/model-auth/cli.js";
import { resolveVercelSession } from "#internal/model-auth/vercel.js";
import type { DevelopmentModelCredential } from "#internal/model-auth/development-broker-protocol.js";

export async function resolveGatewayModelCredential(
  network: Network,
  rejectedToken?: string,
): Promise<DevelopmentModelCredential> {
  const selected = process.env[MODEL_CONNECTION_ENV];
  if (selected === "vercel" || selected === "vercel-cli") {
    if (selected === "vercel-cli" && rejectedToken) await refreshVercelCliConnection();
    const session =
      selected === "vercel"
        ? await resolveVercelSession(rejectedToken)
        : await readVercelCliConnection();
    if (!session) throw new Error("Vercel CLI credentials are unavailable. Run /login.");
    return {
      kind: "oauth",
      token: "accessToken" in session ? session.accessToken : session.token,
      teamId: process.env.EVE_MODEL_TEAM ?? session.teamId,
      teamName:
        process.env.EVE_MODEL_TEAM_NAME ??
        ("teamName" in session ? session.teamName : session.teamId),
    };
  }
  if (selected === "ai-gateway-key")
    return { kind: "api-key", token: await resolveModelApiKey("ai-gateway-key") };
  if (selected !== "ai-gateway-project" && process.env.AI_GATEWAY_API_KEY?.trim())
    return { kind: "api-key", token: process.env.AI_GATEWAY_API_KEY };
  if (network.token === undefined) {
    throw new Error(
      "The installed eve platform gives no workload token for AI Gateway. Configure the model with an AI Gateway API key.",
    );
  }
  return { kind: "oidc", token: await network.token() };
}
