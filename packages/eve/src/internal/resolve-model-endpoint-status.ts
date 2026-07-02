import {
  resolveAiGatewayEndpointStatus,
  type ResolveAiGatewayEndpointStatusOptions,
} from "#internal/model-auth/endpoint/ai-gateway.js";
import {
  resolveCodexEndpointStatus,
  type ResolveCodexEndpointStatusOptions,
} from "#internal/model-auth/endpoint/codex/status.js";
import type { ModelEndpoint } from "#shared/agent-definition.js";
import type { ModelEndpointStatus } from "#shared/model-endpoint-status.js";

export interface ResolveModelEndpointStatusOptions
  extends ResolveAiGatewayEndpointStatusOptions, ResolveCodexEndpointStatusOptions {}

export async function resolveModelEndpointStatus(
  model: { readonly routing: ModelEndpoint; readonly transport?: "codex" },
  options: ResolveModelEndpointStatusOptions = {},
): Promise<ModelEndpointStatus> {
  if (model.transport === "codex") {
    return await resolveCodexEndpointStatus(options);
  }
  if (model.routing.kind === "external") {
    return { kind: "external", provider: model.routing.provider };
  }
  return await resolveAiGatewayEndpointStatus(options);
}
