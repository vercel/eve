import { postCompletedSlackReply } from "eve/channels/slack";
import type { SlackRendererEvents } from "eve/channels/slack";

import { queriesForTurn } from "../../analyst/query-log";
import {
  sqlAttachmentBlock,
  sqlAttachmentMarkdown,
} from "../../analyst/sql-attachment";
import { conflictsWithThreadRoles } from "../../analyst/thread-roles";
import { defineState } from "../../state";
import { isString, withRecentEntry } from "../../values";
import { visualizationReceipts } from "./visualizations/receipts";

/** Notice posted when the thread role guard cancels a turn. */
export const THREAD_ROLE_NOTICE =
  "This thread has answers fetched with someone else's data access. Start a new thread and I'll answer with yours.";

/** Most notice receipts kept; a session cancels one turn at a time. */
const MAX_TRACKED_NOTICES = 20;

/* Turns whose thread role notice Slack confirmed, so a replayed cancellation doesn't post it again. */
const noticeDeliveries = defineState<Record<string, string>>(
  "slack.thread-role-notice-deliveries",
  () => ({})
);

/** Final-reply delivery, swappable in tests. */
export const replyDelivery = { post: postCompletedSlackReply };

/**
 * Coordinate Slack replies after model messages and tool calls.
 *
 * @remarks eve's default renderer buffers intermediate narration for typing
 * status and posts ordinary replies. Successful
 * table/chart delivery suppresses final prose only if the turn has no failed
 * visualization attempts. Later turns retain ordinary replies. Delivery
 * failures propagate rather than triggering a potentially duplicate post.
 * When the turn ran SQL, the reply is posted with a folded "SQL query"
 * section listing the exact queries, through eve's delivery fallbacks.
 * When a turn is cancelled and its caller's role conflicts with the
 * thread's earlier results, the thread gets a notice asking that person to
 * start a new thread, since a cancelled turn otherwise posts nothing. The
 * conflict is checked here, because state the guard writes just before
 * cancelling isn't kept. eve can emit a cancellation again when a durable
 * step retries, so a delivery receipt keeps the notice to one post per turn.
 */
export const replyEvents = {
  async "content.completed"(event, ctx, renderNext) {
    const { channel } = ctx;
    const turnId = event.scope?.turnId ?? ctx.session.turn.id;
    if (
      event.data.phase !== "reply" ||
      event.data.kind !== "text" ||
      !isString(event.data.value)
    ) {
      await renderNext();
      return;
    }
    const receipt = visualizationReceipts.get();
    if (
      receipt !== null &&
      receipt.turnId === turnId &&
      receipt.posted &&
      !receipt.failed
    ) {
      return;
    }
    const queries = queriesForTurn(turnId);
    const attachment = sqlAttachmentBlock(queries);
    if (!(event.data.value && attachment)) {
      await renderNext();
      return;
    }
    await replyDelivery.post(channel, {
      blocks: [{ text: event.data.value, type: "markdown" }, attachment],
      markdown: `${event.data.value}${sqlAttachmentMarkdown(queries)}`,
      text: event.data.value,
    });
  },
  async "turn.settled"(event, ctx, renderNext) {
    const { channel } = ctx;
    if (event.data.outcome !== "cancelled") {
      return renderNext();
    }
    try {
      if (
        conflictsWithThreadRoles(ctx.session.auth.current) &&
        !noticeDeliveries.get()[event.data.turnId]
      ) {
        const posted = await channel.thread.post(THREAD_ROLE_NOTICE);
        if (posted.raw.ok !== true || !posted.id) {
          throw new Error(
            "Could not confirm delivery of the thread role notice."
          );
        }
        noticeDeliveries.update((current) =>
          withRecentEntry(
            current,
            event.data.turnId,
            posted.id,
            MAX_TRACKED_NOTICES
          )
        );
      }
    } finally {
      // eve's default still clears the thread status when the notice fails.
      await renderNext();
    }
  },
} satisfies SlackRendererEvents;
