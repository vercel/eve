import type { RegistrySetupFact } from "#setup/registry-setup-protocol.js";

import type { IntegrationSetupEnvironment } from "./shared/environment.js";
import type { IntegrationSetupUi } from "./shared/ui.js";

/** Inputs available to one registry-owned integration setup flow. */
export interface IntegrationSetupContext {
  readonly appRoot: string;
  readonly environment: IntegrationSetupEnvironment;
  readonly ui: IntegrationSetupUi;
  readonly signal?: AbortSignal;
  readonly force?: boolean;
  readonly yes?: boolean;
  /**
   * When true, shared prerequisites such as Vercel project linking must already
   * be satisfied; they must not open an interactive wizard mid-flow.
   */
  readonly headless?: boolean;
}

/** Outcome from one registry-owned integration setup flow. */
export type IntegrationSetupResult =
  | { readonly kind: "done"; readonly facts?: readonly RegistrySetupFact[] }
  | { readonly kind: "cancelled" };

/** One built-in registry-owned integration setup flow. */
export interface SetupIntegration {
  readonly kind: string;
  readonly label: string;
  readonly hint?: string;
  setup(context: IntegrationSetupContext): Promise<IntegrationSetupResult>;
}
