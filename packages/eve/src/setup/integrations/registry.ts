import { DISCORD_SETUP } from "./discord/setup.js";
import { FILE_MEMORY_SETUP } from "./file-memory/setup.js";
import { GITHUB_SETUP } from "./github/setup.js";
import { LINEAR_SETUP } from "./linear/setup.js";
import { LINQ_SETUP } from "./linq/setup.js";
import { PHOTON_SETUP } from "./photon/setup.js";
import { SELF_MODIFICATION_SETUP } from "./self-modification/setup.js";
import { SHOPIFY_SETUP } from "./shopify/setup.js";
import { SLACK_SETUP } from "./slack/setup.js";
import type { SetupIntegration } from "./types.js";
import { WEB_SETUP } from "./web/setup.js";

/** Built-in registry setup integrations in canonical picker order. */
export const SETUP_INTEGRATIONS: readonly SetupIntegration[] = [
  WEB_SETUP,
  FILE_MEMORY_SETUP,
  SLACK_SETUP,
  DISCORD_SETUP,
  GITHUB_SETUP,
  LINEAR_SETUP,
  LINQ_SETUP,
  PHOTON_SETUP,
  SHOPIFY_SETUP,
  SELF_MODIFICATION_SETUP,
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

export { createSetupContexts, createSetupPresenter } from "./shared/ui.js";
