import {
  resolveAiGatewayEndpointStatus,
  type ResolveAiGatewayEndpointStatusOptions,
} from "#internal/model-auth/endpoint/ai-gateway.js";
import {
  resolveCodexEndpointStatus,
  type ResolveCodexEndpointStatusOptions,
} from "#internal/model-auth/endpoint/codex/status.js";
import type { ModelAuth } from "#shared/agent-definition.js";
import type { ModelEndpointStatus } from "#shared/model-endpoint-status.js";

export interface ResolveModelEndpointStatusOptions
  extends ResolveAiGatewayEndpointStatusOptions, ResolveCodexEndpointStatusOptions {}

export async function resolveModelEndpointStatus(
  auth: ModelAuth,
  options: ResolveModelEndpointStatusOptions = {},
): Promise<ModelEndpointStatus> {
  switch (auth.kind) {
    case "ai-gateway":
      return await resolveAiGatewayEndpointStatus(options);
    case "codex":
      return await resolveCodexEndpointStatus(options);
    case "external":
      return { kind: "external", provider: auth.provider };
  }
}
