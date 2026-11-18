import { APPROVE_OPTION_ID, DENY_OPTION_ID } from "eve/events";
import type { Interaction } from "eve/events";
import { z } from "zod";
/**
 * Slack publication previews, delivery confirmation, and approval labels.
 *
 * @packageDocumentation
 */

import type { SlackInteractionsConfig } from "#lib/integrations/slack/interactions";

import { formatContentfulPublicationPreview } from "./publication-message";
import {
  getContentfulPublicationForApproval,
  recordContentfulPublicationPreview,
} from "./publication-state";

/* The publication call an approval asks about, or undefined for any other request. */
const publicationCall = (interaction: Interaction) => {
  const { call } = interaction;
  return interaction.request.kind === "approval" &&
    call?.name === "publish_contentful_entry"
    ? call
    : undefined;
};

/**
 * Posts the frozen publication scope before eve's approval controls, checkpoints confirmed delivery, and labels the controls Publish and Cancel.
 *
 * @remarks The publication tool refuses to publish until Slack confirms the preview, so an approval typed in the thread can't skip it.
 */
export const contentfulPublicationInteractions: SlackInteractionsConfig = {
  details(interaction) {
    const call = publicationCall(interaction);
    if (!call) {
      return;
    }
    const input = z.json().parse(call.input);
    const preview = formatContentfulPublicationPreview(
      getContentfulPublicationForApproval(call.callId, input)
    );
    return {
      blocks: preview.blocks,
      onPosted: (messageId) =>
        recordContentfulPublicationPreview(call.callId, input, messageId),
      text: preview.text,
    };
  },
  labels(interaction) {
    return publicationCall(interaction)
      ? { [APPROVE_OPTION_ID]: "Publish", [DENY_OPTION_ID]: "Cancel" }
      : undefined;
  },
};
