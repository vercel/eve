import type { ModelRouting } from "#shared/agent-definition.js";
import { isChatGptModelRouting } from "#shared/chatgpt-model.js";
import type { ChatGptEndpointState, ModelEndpointStatus } from "#shared/model-endpoint-status.js";

export interface GatewayCredentialPresence {
  readonly apiKey: boolean;
  readonly oidc: boolean;
  readonly account?: boolean;
  readonly team?: string;
}

export function hasEnvValue(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

export type GatewayCredentialSource = { kind: "env-file"; path: string } | { kind: "shell" };

interface GatewayCredentialEvidence {
  readonly apiKeyFile?: string;
  readonly apiKeyInEnv?: boolean;
  readonly oidcFile?: string;
  readonly oidcAvailable?: boolean;
}

export type GatewayCredentialResolution =
  | {
      credential: "api-key";
      source: GatewayCredentialSource;
    }
  | { credential: "oidc"; file?: string };

export function resolveGatewayCredential(
  evidence: GatewayCredentialEvidence,
): GatewayCredentialResolution | undefined {
  const source: GatewayCredentialSource | undefined =
    evidence.apiKeyFile !== undefined
      ? { kind: "env-file", path: evidence.apiKeyFile }
      : evidence.apiKeyInEnv === true
        ? { kind: "shell" }
        : undefined;
  const hasOidc = evidence.oidcFile !== undefined || evidence.oidcAvailable === true;

  if (source !== undefined) {
    return { credential: "api-key", source };
  }
  if (hasOidc) {
    return evidence.oidcFile === undefined
      ? { credential: "oidc" }
      : { credential: "oidc", file: evidence.oidcFile };
  }
  return undefined;
}

export function resolveModelEndpointStatus(
  routing: ModelRouting,
  credentials: GatewayCredentialPresence,
  chatgpt?: {
    readonly state: ChatGptEndpointState;
    readonly accountLabel?: string;
  },
): ModelEndpointStatus {
  if (routing.kind === "external") {
    if (isChatGptModelRouting(routing) && chatgpt !== undefined) {
      return { kind: "chatgpt", ...chatgpt };
    }
    return { kind: "external", provider: routing.provider };
  }
  if (credentials.account)
    return {
      kind: "gateway",
      connected: true,
      credential: "oauth",
      team: credentials.team,
    };
  const resolution = resolveGatewayCredential({
    apiKeyInEnv: credentials.apiKey,
    oidcAvailable: credentials.oidc,
  });
  if (resolution === undefined) {
    return { kind: "gateway", connected: false };
  }
  return { kind: "gateway", connected: true, credential: resolution.credential };
}
