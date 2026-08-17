import {
  hasEnvValue,
  type GatewayCredentialSource,
} from "#internal/resolve-model-endpoint-status.js";
import type { ModelRouting } from "#shared/agent-definition.js";
import { isChatGptModelRouting } from "#shared/chatgpt-model.js";
import { AI_GATEWAY_API_KEY_ENV_VAR } from "#setup/ai-gateway-api-key.js";
import { findEnvFileWithKey } from "#setup/boxes/detect-ai-gateway.js";
import {
  readGatewayCredentialPreference,
  type GatewayCredentialPreference,
} from "#setup/gateway-credential-preference.js";
import {
  detectProjectIdentity,
  type VercelProjectOperationOptions,
} from "#setup/project-resolution.js";

export type SelectedGatewayProvider = "gateway-project" | "gateway-key";
export type SelectedModelProvider = "chatgpt" | SelectedGatewayProvider;

export interface GatewayProviderAvailability {
  gatewayProject?: {
    readonly projectName?: string;
    readonly teamName?: string;
  };
  gatewayKey?: {
    readonly source: GatewayCredentialSource;
  };
}

/** Independently detected Gateway configuration plus the user's preference. */
export interface GatewayProviderState {
  /** Project-link/OIDC and API-key evidence observed now. */
  readonly available: GatewayProviderAvailability;
  /** The user's Gateway-only override. Authored model routing remains authoritative. */
  readonly preferredGatewayCredential: GatewayCredentialPreference | undefined;
}

/** Reads all Gateway credential choices without collapsing their precedence. */
export async function readGatewayProviderState(
  appRoot: string,
  options: VercelProjectOperationOptions = {},
  env: Record<string, string | undefined> = process.env,
): Promise<GatewayProviderState> {
  const [identity, gatewayKeyFile, oidcFile, preferredGatewayCredential] = await Promise.all([
    detectProjectIdentity(appRoot, options),
    findEnvFileWithKey(appRoot, AI_GATEWAY_API_KEY_ENV_VAR),
    findEnvFileWithKey(appRoot, "VERCEL_OIDC_TOKEN"),
    readGatewayCredentialPreference(appRoot),
  ]);
  const available: GatewayProviderAvailability = {};
  if (identity !== undefined || oidcFile !== undefined) {
    const project: { projectName?: string; teamName?: string } = {};
    if (identity !== undefined) {
      project.projectName = identity.projectName;
      project.teamName = identity.teamName;
    }
    available.gatewayProject = project;
  }
  if (gatewayKeyFile !== undefined) {
    available.gatewayKey = { source: { kind: "env-file", path: gatewayKeyFile } };
  } else if (hasEnvValue(env[AI_GATEWAY_API_KEY_ENV_VAR])) {
    available.gatewayKey = { source: { kind: "shell" } };
  }
  return { available, preferredGatewayCredential };
}

/** Resolves the setup selection, with authored ChatGPT routing taking precedence. */
export function resolveSelectedModelProvider(
  state: GatewayProviderState,
  routing: ModelRouting | null,
): SelectedModelProvider {
  if (isChatGptModelRouting(routing)) return "chatgpt";
  if (state.preferredGatewayCredential === "project") return "gateway-project";
  if (state.preferredGatewayCredential === "api-key") return "gateway-key";
  if (state.available.gatewayKey !== undefined) return "gateway-key";
  return "gateway-project";
}

export function isSelectedModelProviderConfigured(
  state: GatewayProviderState,
  selected: SelectedModelProvider,
): boolean {
  if (selected === "chatgpt") return true;
  return selected === "gateway-project"
    ? state.available.gatewayProject !== undefined
    : state.available.gatewayKey !== undefined;
}
