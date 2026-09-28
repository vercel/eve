import {
  developmentModelBrokerAvailable,
  readDevelopmentModelCredential,
} from "#internal/model-auth/development-broker-client.js";
import type { ChatGptAuthState } from "#public/models/openai/chatgpt/token-broker.js";
import { isEveDevEnvironment } from "#internal/application/dev-environment.js";
import { resolveGatewayModelCredential } from "#internal/model-auth/gateway-credential.js";
import { getVercelOidcToken } from "#compiled/@vercel/oidc/index.js";
import { hasEnvValue } from "#internal/resolve-model-endpoint-status.js";
import { buildAgentInfoResponse } from "#internal/nitro/routes/agent-info/build-agent-info-response.js";
import {
  loadAgentInfoManifestData,
  resolveAgentInfoCompiledArtifactsSource,
} from "#internal/nitro/routes/agent-info/load-agent-info-data.js";
import type { GatewayCredentialPresence } from "#internal/resolve-model-endpoint-status.js";
import type { NitroArtifactsConfig } from "#internal/nitro/routes/runtime-artifacts.js";
import { getDefaultCodexTokenBroker } from "#public/models/openai/chatgpt/token-broker.js";
import type { ModelRouting } from "#shared/agent-definition.js";
import { isChatGptModelRouting } from "#shared/chatgpt-model.js";

async function createAgentInfoPayload(input: NitroArtifactsConfig) {
  const data = await loadAgentInfoManifestData({
    compiledArtifactsSource: resolveAgentInfoCompiledArtifactsSource(input),
  });

  const routing = data.manifest.config.model?.routing;
  return buildAgentInfoResponse(data, {
    mode: input.kind,
    gatewayCredentials:
      routing === undefined
        ? { apiKey: false, oidc: false }
        : await resolveGatewayCredentialPresence(routing),
    ...(isChatGptModelRouting(routing) ? { chatgptAuth: await resolveChatGptAuthState() } : {}),
  });
}

async function resolveChatGptAuthState(): Promise<ChatGptAuthState> {
  if (!developmentModelBrokerAvailable()) return getDefaultCodexTokenBroker().refreshState();
  try {
    const credential = await readDevelopmentModelCredential("chatgpt");
    return { kind: "ready", accountLabel: credential?.accountLabel };
  } catch {
    return { kind: "signed-out" };
  }
}

/**
 * Mirrors the AI Gateway credential selection order. The Vercel OIDC SDK owns
 * request-context, environment, and linked-project token resolution; lookup
 * failure means the gateway is unavailable and must not break agent inspection.
 */
async function resolveGatewayCredentialPresence(
  routing: ModelRouting,
): Promise<GatewayCredentialPresence> {
  if (routing.kind === "gateway" && isEveDevEnvironment()) {
    try {
      const credential =
        (await readDevelopmentModelCredential("gateway")) ??
        (await resolveGatewayModelCredential());
      return {
        apiKey: credential.kind === "api-key",
        oidc: credential.kind === "oidc",
        account: credential.kind === "oauth",
        team: credential.teamName,
      };
    } catch {
      return { apiKey: false, oidc: false };
    }
  }
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
