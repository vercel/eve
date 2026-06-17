import { getVercelOidcToken } from "#compiled/@vercel/oidc/index.js";
import { buildAgentInfoResponseFromManifest } from "#internal/nitro/routes/agent-info/build-agent-info-response-from-manifest.js";
import {
  loadAgentInfoManifestData,
  resolveAgentInfoCompiledArtifactsSource,
} from "#internal/nitro/routes/agent-info/load-agent-info-data.js";
import type { GatewayCredentialPresence } from "#internal/resolve-model-endpoint-status.js";
import type { NitroArtifactsConfig } from "#internal/nitro/routes/runtime-artifacts.js";
import { localDev, routeAuth, vercelOidc } from "#public/channels/auth.js";
import type { ModelRouting } from "#shared/agent-definition.js";

type AgentInfoRouteMode = "development" | "production";

interface AgentInfoRouteInput extends NitroArtifactsConfig {
  readonly mode?: AgentInfoRouteMode;
}

async function createAgentInfoPayload(input: AgentInfoRouteInput) {
  const data = await loadAgentInfoManifestData({
    compiledArtifactsSource: resolveAgentInfoCompiledArtifactsSource(input),
  });

  return buildAgentInfoResponseFromManifest(data, {
    mode: input.mode ?? "development",
    gatewayCredentials: await resolveGatewayCredentialPresence(data.manifest.config.model.routing),
  });
}

function hasEnvValue(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
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
 *
 * The route keeps the same default auth chain as the eve channel:
 * local development requests are accepted by hostname, while deployed
 * Vercel targets require a valid OIDC bearer.
 */
export async function handleAgentInfoRequest(
  input: AgentInfoRouteInput,
  request: Request,
): Promise<Response> {
  const authResult = await routeAuth(request, [localDev(), vercelOidc()]);
  if (authResult instanceof Response) return authResult;

  return new Response(JSON.stringify(await createAgentInfoPayload(input)), {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}
