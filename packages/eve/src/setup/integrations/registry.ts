import type { ChannelSetupIntegration } from "./types.js";
import { SLACK_CHANNEL_SETUP } from "./slack/setup.js";
import { WEB_CHANNEL_SETUP } from "./web/setup.js";

/** Built-in channel integrations in canonical picker order. */
export const CHANNEL_SETUP_INTEGRATIONS: readonly ChannelSetupIntegration[] = [
  WEB_CHANNEL_SETUP,
  SLACK_CHANNEL_SETUP,
];

/** Resolves a channel setup integration by its filesystem-facing kind. */
/** Resolves one built-in setup integration by its registry setup name. */
export function setupIntegration(kind: string): ChannelSetupIntegration {
  const integration = CHANNEL_SETUP_INTEGRATIONS.find((candidate) => candidate.kind === kind);
  if (integration === undefined) {
    throw new Error(
      `Integration setup "${kind}" is not available in this version of eve. Upgrade eve and try again.`,
    );
  }
  return integration;
}

export { createChannelSetupUi } from "./shared/ui.js";
