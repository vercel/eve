import { buildAgentInfoResponseFromManifest } from "#internal/nitro/routes/agent-info/build-agent-info-response-from-manifest.js";
import {
  loadAgentInfoManifestData,
  resolveAgentInfoCompiledArtifactsSource,
} from "#internal/nitro/routes/agent-info/load-agent-info-data.js";
import type { NitroArtifactsConfig } from "#internal/nitro/routes/runtime-artifacts.js";
import { localDev, routeAuth, vercelOidc } from "#public/channels/auth.js";

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
  });
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
  const authResult = await routeAuth(request, [vercelOidc(), localDev()]);
  if (authResult instanceof Response) return authResult;

  return new Response(JSON.stringify(await createAgentInfoPayload(input)), {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}
