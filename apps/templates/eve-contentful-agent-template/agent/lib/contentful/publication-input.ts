import { z } from "zod";
/**
 * Slack publication controls, delivery confirmation, and signed-responder admission.
 *
 * @packageDocumentation
 */

import { inputRequestButtons } from "#lib/integrations/slack/input-requests";
import type { SlackInputRequestsConfig } from "#lib/integrations/slack/input-requests";

import { formatContentfulPublicationPreview } from "./publication-message";
import {
  getContentfulPublicationForApproval,
  recordContentfulPublicationPreview,
} from "./publication-state";

const PUBLICATION_CONTROLS = "contentful_publication";

/* Render the frozen scope with native controls and checkpoint confirmed delivery. */
export const contentfulPublicationInput: SlackInputRequestsConfig = {
  render(request) {
    if (
      request.kind !== "tool-approval" ||
      request.action.toolName !== "publish_contentful_entry"
    ) {
      return;
    }
    const { callId, input } = request.action;
    const plan = getContentfulPublicationForApproval(
      callId,
      z.json().parse(input)
    );
    const preview = formatContentfulPublicationPreview(plan);
    const blocks = preview.blocks.map((block) =>
      block.type === "container"
        ? {
            ...block,
            child_blocks: [
              ...block.child_blocks,
              {
                block_id: PUBLICATION_CONTROLS,
                elements: inputRequestButtons(request, {
                  approve: "Publish",
                  cancel: "Cancel",
                }),
                type: "actions",
              },
            ],
          }
        : block
    );
    return {
      blocks,
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
