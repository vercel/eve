import { getVercelOidcToken } from "#compiled/@vercel/oidc/index.js";
import { hasEnvValue } from "#internal/resolve-model-endpoint-status.js";
import { buildAgentInfoResponseFromManifest } from "#internal/nitro/routes/agent-info/build-agent-info-response-from-manifest.js";
import {
  loadAgentInfoManifestData,
  resolveAgentInfoCompiledArtifactsSource,
} from "#internal/nitro/routes/agent-info/load-agent-info-data.js";
import type { GatewayCredentialPresence } from "#internal/resolve-model-endpoint-status.js";
import type { NitroArtifactsConfig } from "#internal/nitro/routes/runtime-artifacts.js";
import type { ModelRouting } from "#shared/agent-definition.js";

async function createAgentInfoPayload(input: NitroArtifactsConfig) {
  const data = await loadAgentInfoManifestData({
    compiledArtifactsSource: resolveAgentInfoCompiledArtifactsSource(input),
  });

  return buildAgentInfoResponseFromManifest(data, {
    mode: input.kind,
    gatewayCredentials: await resolveGatewayCredentialPresence(data.manifest.config.model.routing),
  });
}

/**
 * Mirrors the AI Gateway credential selection order. The Vercel OIDC SDK owns
 * request-context, environment, and linked-project token resolution; lookup
 * failure means the gateway is unavailable and must not break agent inspection.
 */
async function resolveGatewayCredentialPresence(
  routing: ModelRouting,
): Promise<GatewayCredentialPresence> {
  const apiKey = hasEnvValue(process.env.AI_GATEWAY_API_KEY);

  if (routing.kind === "external" || apiKey) {
    return { apiKey, oidc: false };
  }

  try {
    await getVercelOidcToken();
    return { apiKey: false, oidc: true };
  } catch {
    return { apiKey: false, oidc: false };
  }
}

/**
 * Builds the package-owned JSON inspection response for the current agent.
 */
export async function handleAgentInfoRequest(input: NitroArtifactsConfig): Promise<Response> {
  return new Response(JSON.stringify(await createAgentInfoPayload(input)), {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}
