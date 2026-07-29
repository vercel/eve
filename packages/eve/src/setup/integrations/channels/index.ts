import type { ChannelSetupIntegration } from "./types.js";
import { SLACK_CHANNEL_SETUP } from "./slack.js";
import { WEB_CHANNEL_SETUP } from "./web.js";
import type { ChannelKind } from "../../scaffold/index.js";

/** Built-in channel integrations in canonical picker order. */
export const CHANNEL_SETUP_INTEGRATIONS: readonly ChannelSetupIntegration[] = [
  WEB_CHANNEL_SETUP,
  SLACK_CHANNEL_SETUP,
];

/** Resolves a channel setup integration by its filesystem-facing kind. */
export function channelSetupIntegration(kind: ChannelKind): ChannelSetupIntegration {
  const integration = CHANNEL_SETUP_INTEGRATIONS.find((candidate) => candidate.kind === kind);
  if (integration === undefined) throw new Error(`No channel setup integration for "${kind}".`);
  return integration;
}

export { createChannelSetupUi } from "./ui.js";
