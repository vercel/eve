import type { SlackRendererEvents } from "eve/channels/slack";

import { visualizationReceipts } from "./visualizations/receipts";

/**
 * Coordinate Slack replies after model messages and tool calls.
 *
 * @remarks eve's default renderer buffers intermediate narration for typing
 * status and posts ordinary replies. Successful
 * table/chart delivery suppresses final prose only if the turn has no failed
 * visualization attempts. Later turns retain ordinary replies. Delivery
 * failures propagate rather than triggering a potentially duplicate post.
 */
export const replyEvents = {
  async "content.completed"(event, _ctx, renderNext) {
    if (event.data.phase !== "reply" || event.data.kind !== "text") {
      await renderNext();
      return;
    }
    const receipt = visualizationReceipts.get();
    if (
      receipt !== null &&
      receipt.turnId === event.scope?.turnId &&
      receipt.posted &&
      !receipt.failed
    ) {
      return;
    }
    await renderNext();
  },
} satisfies SlackRendererEvents;
