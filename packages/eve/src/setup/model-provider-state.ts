import type { GatewayCredentialSource } from "#internal/resolve-model-endpoint-status.js";
import type { ModelRouting } from "#shared/agent-definition.js";
import type { GatewayCredentialPreference } from "#setup/gateway-credential-preference.js";

export type SelectedGatewayProvider = "gateway-project" | "gateway-key";
export type SelectedModelProvider = "chatgpt" | SelectedGatewayProvider;

export interface ModelProviderAvailability {
  gatewayProject?: {
    readonly projectName?: string;
    readonly teamName?: string;
    readonly oidcFile?: string;
  };
  gatewayKey?: {
    readonly source: GatewayCredentialSource;
  };
}

/** Runtime routing plus the independently available Gateway credentials. */
export interface ModelProviderState {
  /** Credentials observed now. Both Gateway options may be available. */
  readonly available: ModelProviderAvailability;
  /** The user's Gateway-only override. Authored model routing remains authoritative. */
  readonly preferredGatewayCredential: GatewayCredentialPreference | undefined;
}

/** Resolves the setup selection, with authored ChatGPT routing taking precedence. */
export function resolveSelectedModelProvider(
  state: ModelProviderState,
  routing: ModelRouting | null,
): SelectedModelProvider {
  if (routing?.kind === "external" && routing.provider === "codex") return "chatgpt";
  if (state.preferredGatewayCredential === "project") return "gateway-project";
  if (state.preferredGatewayCredential === "api-key") return "gateway-key";
  // This is the AI SDK's normal precedence when both credentials exist.
  if (state.available.gatewayKey !== undefined) return "gateway-key";
  if (state.available.gatewayProject !== undefined) return "gateway-project";
  return "gateway-project";
}

export type SelectedModelProviderStatus =
  | { readonly kind: "unset" }
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

/** Projects a resolved Gateway selection onto current availability. */
export function resolveSelectedModelProviderStatus(
  state: ModelProviderState,
  selected: SelectedModelProvider,
): SelectedModelProviderStatus {
  if (selected === "gateway-project") {
    const project = state.available.gatewayProject;
    if (project === undefined) return { kind: "unset" };
    const status: {
      kind: "gateway-project";
      projectName?: string;
      teamName?: string;
    } = { kind: "gateway-project" };
    if (project.projectName !== undefined) status.projectName = project.projectName;
    if (project.teamName !== undefined) status.teamName = project.teamName;
    return status;
  }
  if (selected === "gateway-key") {
    const key = state.available.gatewayKey;
    return key === undefined
      ? { kind: "unset" }
      : { kind: "gateway-key", envKey: "AI_GATEWAY_API_KEY", source: key.source };
  }
  return { kind: "unset" };
}
