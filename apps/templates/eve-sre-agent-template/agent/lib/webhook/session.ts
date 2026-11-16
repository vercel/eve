import { randomUUID } from "node:crypto";
import type { RouteHandlerArgs } from "eve/channels";
import { createServiceAuth } from "#lib/auth.ts";
import {
  buildInitialInvestigationCard,
  formatInitialInvestigationFallbackText,
} from "#lib/slack/investigation-rendering.ts";
import type { InvestigationWebhook } from "./payload.ts";

type CrossChannelTo = RouteHandlerArgs["to"];
export type SlackChannelTarget = Parameters<CrossChannelTo>[0];

export function formatInvestigationPrompt(
  webhook: InvestigationWebhook
): string {
  const { title, description, metadata } = webhook;

  let renderedMetadata = "";
  try {
    renderedMetadata = `**Metadata**: ${JSON.stringify(metadata, null, 2)}`;
  } catch (err) {
    console.warn(
      "Failed to parse metadata from webhook-initiated investigation",
      err
    );
    renderedMetadata = "";
  }

  return `Investigate the following issue end-to-end using available tools and using metadata to hydrate context:

  **Title**: ${title}

  ${description ? `**Description**: ${description}` : ""}

  ${renderedMetadata}`;
}

export async function startInvestigation(
  webhook: InvestigationWebhook,
  to: CrossChannelTo,
  slack: SlackChannelTarget
): Promise<void> {
  const auth = createServiceAuth({
    authenticator: "investigate",
    principalId: randomUUID(),
  });

  await to(slack, {
    channelId: webhook.slackChannel,
    initialMessage: {
      card: buildInitialInvestigationCard(webhook.title),
      fallbackText: formatInitialInvestigationFallbackText(webhook.title),
    },
  }).send(formatInvestigationPrompt(webhook), {
    auth,
  });
}
