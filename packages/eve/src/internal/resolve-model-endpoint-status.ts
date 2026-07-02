import {
  aiGatewayEndpoint,
  type ResolveAiGatewayEndpointStatusOptions,
} from "#internal/model-auth/endpoint/ai-gateway.js";
import {
  codexEndpoint,
  type ResolveCodexEndpointStatusOptions,
} from "#internal/model-auth/endpoint/codex/endpoint.js";
import type { ModelEndpoint } from "#shared/agent-definition.js";
import type { ModelEndpointStatus } from "#shared/model-endpoint-status.js";

export interface ResolveModelEndpointStatusOptions
  extends ResolveAiGatewayEndpointStatusOptions, ResolveCodexEndpointStatusOptions {}

export async function resolveModelEndpointStatus(
  model: { readonly routing: ModelEndpoint; readonly transport?: "codex" },
  options: ResolveModelEndpointStatusOptions = {},
): Promise<ModelEndpointStatus> {
  if (model.transport === "codex") {
    return await codexEndpoint.resolveStatus(options);
  }
  if (model.routing.kind === "external") {
    return { kind: "external", provider: model.routing.provider };
  }
  return await aiGatewayEndpoint.resolveStatus(options);
}
