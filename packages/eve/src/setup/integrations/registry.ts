import { PHOTON_SETUP } from "./photon/setup.js";
import { SLACK_SETUP } from "./slack/setup.js";
import type { SetupIntegration } from "./types.js";
import { WEB_SETUP } from "./web/setup.js";

/** Built-in registry setup integrations in canonical picker order. */
export const SETUP_INTEGRATIONS: readonly SetupIntegration[] = [
  WEB_SETUP,
  SLACK_SETUP,
  PHOTON_SETUP,
];

/** Resolves one built-in setup integration by its registry setup name. */
export function setupIntegration(kind: string): SetupIntegration {
  const integration = SETUP_INTEGRATIONS.find((candidate) => candidate.kind === kind);
  if (integration === undefined) {
    throw new Error(
      `Integration setup "${kind}" is not available in this version of eve. Upgrade eve and try again.`,
    );
  }
  return integration;
}

export { createIntegrationSetupUi } from "./shared/ui.js";
