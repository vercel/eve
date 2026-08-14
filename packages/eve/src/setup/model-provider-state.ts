import {
  hasEnvValue,
  resolveGatewayCredential,
  type GatewayCredentialSource,
} from "#internal/resolve-model-endpoint-status.js";
import type { ModelRouting } from "#shared/agent-definition.js";
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
  const credential = resolveGatewayCredential({
    apiKeyFile: gatewayKeyFile,
    apiKeyInEnv: hasEnvValue(env[AI_GATEWAY_API_KEY_ENV_VAR]),
    oidcFile,
    oidcAvailable: identity !== undefined,
  });
  const available: GatewayProviderAvailability = {};
  if (
    credential?.credential === "oidc" ||
    (credential?.credential === "api-key" && credential.shadowedOidc !== undefined)
  ) {
    const project: { projectName?: string; teamName?: string } = {};
    if (identity !== undefined) {
      project.projectName = identity.projectName;
      project.teamName = identity.teamName;
    }
    available.gatewayProject = project;
  }
  if (credential?.credential === "api-key") {
    available.gatewayKey = { source: credential.source };
  }
  return { available, preferredGatewayCredential };
}

/** Resolves the setup selection, with authored ChatGPT routing taking precedence. */
export function resolveSelectedModelProvider(
  state: GatewayProviderState,
  routing: ModelRouting | null,
): SelectedModelProvider {
  if (routing?.kind === "external" && routing.provider === "codex") return "chatgpt";
  if (state.preferredGatewayCredential === "project") return "gateway-project";
  if (state.preferredGatewayCredential === "api-key") return "gateway-key";
  const credential = resolveGatewayCredential({
    apiKeyInEnv: state.available.gatewayKey !== undefined,
    oidcAvailable: state.available.gatewayProject !== undefined,
  });
  return credential?.credential === "api-key" ? "gateway-key" : "gateway-project";
}

export type GatewayProviderStatus =
  | { readonly kind: "unconfigured" }
  | {
      readonly kind: "gateway-project";
      readonly projectName?: string;
      readonly teamName?: string;
    }
  | {
      readonly kind: "gateway-key";
      readonly envKey: "AI_GATEWAY_API_KEY";
      readonly source: GatewayCredentialSource;
    };

export type ModelProviderStatus = { readonly kind: "chatgpt" } | GatewayProviderStatus;

/** Projects a resolved Gateway selection onto the evidence detected for it. */
export function resolveSelectedGatewayProviderStatus(
  state: GatewayProviderState,
  selected: SelectedGatewayProvider,
): GatewayProviderStatus {
  if (selected === "gateway-project") {
    const project = state.available.gatewayProject;
    if (project === undefined) return { kind: "unconfigured" };
    const status: {
      kind: "gateway-project";
      projectName?: string;
      teamName?: string;
    } = { kind: "gateway-project" };
    if (project.projectName !== undefined) status.projectName = project.projectName;
    if (project.teamName !== undefined) status.teamName = project.teamName;
    return status;
  }
  const key = state.available.gatewayKey;
  return key === undefined
    ? { kind: "unconfigured" }
    : { kind: "gateway-key", envKey: "AI_GATEWAY_API_KEY", source: key.source };
}

/** Projects the selected provider onto the evidence displayed by `/model`. */
export function resolveSelectedModelProviderStatus(
  state: GatewayProviderState,
  selected: SelectedModelProvider,
): ModelProviderStatus {
  if (selected === "chatgpt") return { kind: "chatgpt" };
  return resolveSelectedGatewayProviderStatus(state, selected);
}
