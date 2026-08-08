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
   * True when the caller has no terminal: prompts resolve from keyed answers
   * or refuse, and one-time interactive prerequisites (Vercel project
   * linking) are completed separately instead of opening a flow.
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
