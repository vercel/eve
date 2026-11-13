import { z } from "zod";

import type { JsonObject } from "../../../json";
import { requireEnv } from "../../../utils/env";
import { slackApi } from "../api";
import { slackThreadFromSession } from "../session";
import type { SlackSessionContext } from "../session";
import { recordVisualizationDelivery } from "./receipts";

export const visualizationDelivery = { record: recordVisualizationDelivery };

const BLOCK_ERROR = /block/iu;

/* Small delivery receipt shared by table and chart tools; no chart/table data is echoed. */
export const visualizationOutputSchema = z.object({
  channel: z.string().optional(),
  error: z.string().optional(),
  posted: z.boolean(),
  threadTs: z.string().optional(),
  usedTextFallback: z.boolean().optional(),
});

/**
 * Posts one visualization message to the authenticated session's Slack thread.
 *
 * @param ctx - Session origin and current turn used to record delivery.
 * @param message - Slack blocks and their readable text alternative, including any truncation notice.
 * @returns Delivery outcome, including whether Slack required the text fallback.
 * @remarks Retries once with text only after an explicit block rejection. Thrown
 * errors and other rejections are not retried because delivery may be uncertain.
 * Records success/failure for final-reply suppression and session continuation.
 */
export const postVisualization = async (
  ctx: SlackSessionContext & { session: { turn: { id: string } } },
  message: { blocks: JsonObject[]; text: string }
): Promise<z.infer<typeof visualizationOutputSchema>> => {
  const turnId = ctx.session.turn.id;
  const thread = slackThreadFromSession(ctx);
  if (!thread) {
    visualizationDelivery.record(turnId, false);
    return {
      error: "The current session has no Slack thread to post to.",
      posted: false,
    };
  }
  try {
    const { botToken } = slackApi.credentials(
      requireEnv("SLACK_CONNECTOR", "slack/your-agent")
    );
    const post = (body: JsonObject) =>
      slackApi.request({
        body: {
          channel: thread.channelId,
          thread_ts: thread.ts,
          unfurl_links: false,
          ...body,
        },
        botToken,
        operation: "chat.postMessage",
      });
    const withBlocks = await post(message);
    if (withBlocks.ok === true) {
      visualizationDelivery.record(turnId, true);
      return { channel: thread.channelId, posted: true, threadTs: thread.ts };
    }
    const error = String(withBlocks.error ?? "unknown_error");
    if (!BLOCK_ERROR.test(error)) {
      visualizationDelivery.record(turnId, false);
      return { error, posted: false };
    }
    const textOnly = await post({ text: message.text });
    visualizationDelivery.record(turnId, textOnly.ok === true);
    return textOnly.ok === true
      ? {
          channel: thread.channelId,
          posted: true,
          threadTs: thread.ts,
          usedTextFallback: true,
        }
      : { error: String(textOnly.error ?? "unknown_error"), posted: false };
  } catch (error) {
    visualizationDelivery.record(turnId, false);
    return {
      error: error instanceof Error ? error.message : "Slack post failed",
      posted: false,
    };
  }
};
