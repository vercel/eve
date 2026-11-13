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
  async "message.completed"(event, channel, _ctx, renderNext) {
    if (event.finishReason === "tool-calls") {
      await renderNext();
      return;
    }
    channel.state.pendingToolCallMessage = null;

    const receipt = visualizationReceipts.get();
    if (receipt?.turnId === event.turnId && receipt.posted && !receipt.failed) {
      return;
    }
    await renderNext();
  },
} satisfies SlackRendererEvents;
