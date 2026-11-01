import { getVercelOidcToken } from "#compiled/@vercel/oidc/index.js";
import { MODEL_CONNECTION_ENV } from "#shared/model-helper.js";
import { resolveModelApiKey } from "./api-key.js";
import { fetchModelCredential } from "./development-broker-client.js";
import { readVercelCliConnection, refreshVercelCliConnection } from "./vercel-cli.js";
import { resolveVercelSession } from "./vercel.js";
import type { DevelopmentModelCredential } from "./development-broker-protocol.js";

/** Set by a process that launches eve and serves its credential: it outranks every other source. */
export const MODEL_CREDENTIAL_URL_ENV = "EVE_MODEL_CREDENTIAL_URL";
export const MODEL_CREDENTIAL_TOKEN_ENV = "EVE_MODEL_CREDENTIAL_TOKEN";

export async function resolveGatewayModelCredential(
  rejectedToken?: string,
): Promise<DevelopmentModelCredential> {
  const served = process.env[MODEL_CREDENTIAL_URL_ENV];
  if (served) {
    const token = process.env[MODEL_CREDENTIAL_TOKEN_ENV];
    if (!token)
      throw new Error(`${MODEL_CREDENTIAL_URL_ENV} is set without ${MODEL_CREDENTIAL_TOKEN_ENV}.`);
    return fetchModelCredential(served, { authorization: `Bearer ${token}` }, rejectedToken);
  }
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
  return { kind: "oidc", token: await getVercelOidcToken() };
}
