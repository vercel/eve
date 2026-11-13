import { z } from "zod";
/**
 * Slack publication controls, delivery confirmation, and signed-responder admission.
 *
 * @packageDocumentation
 */

import type { SlackInputRequestsConfig } from "#lib/integrations/slack/input-requests";

import { formatContentfulPublicationPreview } from "./publication-message";
import {
  getContentfulPublicationForApproval,
  recordContentfulPublicationPreview,
} from "./publication-state";

/* Render the frozen scope with native controls and checkpoint confirmed delivery. */
export const contentfulPublicationInput: SlackInputRequestsConfig = {
  render(request) {
    if (
      request.request.kind !== "approval" ||
      request.call?.name !== "publish_contentful_entry"
    ) {
      return;
    }
    const { callId, input } = request.call;
    const plan = getContentfulPublicationForApproval(
      callId,
      z.json().parse(input)
    );
    const preview = formatContentfulPublicationPreview(plan);
    return {
      blocks: preview.blocks,
      onPosted: (messageId) =>
        recordContentfulPublicationPreview(
          callId,
          z.json().parse(input),
          messageId
        ),
      text: preview.text,
    };
  },
};
