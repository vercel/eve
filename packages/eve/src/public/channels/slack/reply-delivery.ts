import { replyTextOf } from "#public/channels/reply.js";
import { createLogger } from "#internal/logging.js";
import {
  SLACK_MARKDOWN_TEXT_MAX_LENGTH,
  truncateMessageText,
} from "#public/channels/slack/limits.js";
import { reportUndeliveredReply } from "#public/channels/undelivered-reply.js";
import type {
  SlackChannelInternalEvents,
  SlackChannelContext,
  SlackContext,
} from "#public/channels/slack/slackChannel.js";

const log = createLogger("slack.reply");
const LONG_RESPONSE_FILENAME = "eve-response.md";
const LONG_RESPONSE_NOTICE = "Here's a snippet with the full response.";
const FALLBACK_LOG = "Slack refused the final reply; delivering it with a fallback";
const ROOT_GONE_LOG = "Slack thread root was deleted; dropping the final reply";

const REFUSED_PAYLOAD_ERRORS = new Set([
  "invalid_blocks",
  "invalid_blocks_format",
  "msg_blocks_too_long",
  "msg_blocks_too_many",
  "msg_too_long",
]);

type ContentCompletedHandler = NonNullable<SlackChannelInternalEvents["content.completed"]>;

/**
 * A completed reply for {@link postCompletedSlackReply}: Markdown alone, or
 * Markdown with the Block Kit blocks to try first. `markdown` is the full
 * reply eve falls back to; `text` is the notification text for the blocks,
 * defaulting to `markdown`.
 */
export type SlackCompletedReply =
  | string
  | {
      readonly markdown: string;
      readonly blocks?: readonly unknown[];
      readonly text?: string;
    };

/**
 * Posts a completed reply to the bound Slack thread with eve's delivery
 * fallbacks, using only the content you pass. eve's default renderer posts
 * its replies through it; an authored renderer opts in by calling it instead
 * of `channel.thread.post`.
 *
 * eve tries, in order:
 *
 * 1. Your `blocks`, when given, with `text` as the notification text.
 * 2. `markdown` as one native Markdown message, when it fits in
 *    {@link SLACK_MARKDOWN_TEXT_MAX_LENGTH} characters. eve moves on from
 *    the blocks only when Slack refuses them as too large or malformed
 *    (`msg_too_long`, `msg_blocks_too_long`, `msg_blocks_too_many`,
 *    `invalid_blocks`, or `invalid_blocks_format`).
 * 3. `markdown` uploaded unchanged as an `eve-response.md` snippet with a
 *    short note, when it is longer or Slack refuses the Markdown message.
 *    This requires the `files:write` bot scope. In a session without a
 *    thread yet, the note posts first and anchors the thread.
 *
 * Before any of that, while eve has not yet posted in the thread, it checks
 * that the bound thread's root still exists. Slack posts a reply to a
 * deleted root as a top-level channel message, so eve drops the reply
 * instead of posting it unthreaded.
 *
 * Any other error, and a failed upload, is thrown so your renderer sees it.
 * eve logs each fallback it takes with Slack's error code, never the reply.
 *
 * @example
 * ```ts
 * import { postCompletedSlackReply } from "eve/channels/slack";
 *
 * await postCompletedSlackReply(channel, {
 *   blocks: [{ type: "markdown", text: reply }, sourcesBlock],
 *   markdown: reply,
 * });
 * ```
 */
export async function postCompletedSlackReply(
  channel: SlackContext,
  reply: SlackCompletedReply,
): Promise<void> {
  await deliverCompletedSlackReply(channel, reply, {});
}

export async function deliverCompletedSlackReply(
  channel: SlackContext,
  reply: SlackCompletedReply,
  options: { readonly rootGone?: Promise<boolean>; readonly turnId?: string },
): Promise<void> {
  const { blocks, markdown, text } = typeof reply === "string" ? { markdown: reply } : reply;
  const logFields = options.turnId === undefined ? {} : { turnId: options.turnId };
  if (await (options.rootGone ?? checkThreadRootGone(channel))) {
    log.warn(ROOT_GONE_LOG, logFields);
    return;
  }
  let slackError: string | undefined;
  if (blocks !== undefined) {
    try {
      await channel.thread.post({ blocks, text: text ?? truncateMessageText(markdown) });
      return;
    } catch (error) {
      slackError = refusedPayloadError(error);
      if (slackError === undefined) throw error;
    }
  }
  if (markdown.length <= SLACK_MARKDOWN_TEXT_MAX_LENGTH) {
    if (slackError !== undefined) {
      log.warn(FALLBACK_LOG, { fallback: "inline", slackError, ...logFields });
    }
    try {
      await channel.thread.post(markdown);
      return;
    } catch (error) {
      slackError = refusedPayloadError(error);
      if (slackError === undefined) throw error;
    }
  }
  if (slackError !== undefined) {
    log.warn(FALLBACK_LOG, { fallback: "snippet", slackError, ...logFields });
  }
  await uploadReplySnippet(channel, markdown);
}

export async function checkThreadRootGone(channel: SlackContext): Promise<boolean> {
  const { channelId, codeChannel, threadTs } = channel.slack;
  if (!channelId || !threadTs || codeChannel) return false;
  if ((channel as Partial<SlackChannelContext>).state?.postedInThread === true) return false;
  try {
    const response = await channel.slack.request("chat.getPermalink", {
      channel: channelId,
      message_ts: threadTs,
    });
    return response.ok !== true && response.error === "message_not_found";
  } catch {
    return false;
  }
}

async function uploadReplySnippet(channel: SlackContext, message: string): Promise<void> {
  const file = {
    data: new Blob([message], { type: "text/markdown" }),
    filename: LONG_RESPONSE_FILENAME,
    mimeType: "text/markdown",
  };

  const hasThread = channel.slack.codeChannel || channel.slack.threadTs.length > 0;
  if (!hasThread) {
    const anchor = await channel.thread.post(LONG_RESPONSE_NOTICE);
    if (!anchor.id || channel.slack.threadTs.length === 0) {
      throw new Error("Slack did not return a thread timestamp for the long response notice.");
    }
  }
  await channel.slack.uploadFiles([file], {
    initialComment: hasThread ? LONG_RESPONSE_NOTICE : undefined,
    snippetType: "markdown",
  });
}

export function isRefusedPayloadCode(code: unknown): code is string {
  return typeof code === "string" && REFUSED_PAYLOAD_ERRORS.has(code);
}

export function refusedPayloadError(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    const candidate = current as {
      readonly cause?: unknown;
      readonly data?: { readonly error?: unknown };
      readonly response?: { readonly error?: unknown };
    };
    const code = candidate.response?.error ?? candidate.data?.error;
    if (isRefusedPayloadCode(code)) return code;
    current = candidate.cause;
  }
  return undefined;
}

export function withFinalReplyDelivery(
  render: ContentCompletedHandler | undefined,
): ContentCompletedHandler {
  return async (event, ctx) => {
    if (replyTextOf(event.data) === undefined) {
      await render?.(event, ctx);
      return;
    }
    try {
      await render?.(event, ctx);
    } catch (error) {
      const { channel } = ctx;
      await reportUndeliveredReply(
        { log, name: "Slack", post: (notice) => channel.thread.post(notice), state: channel.state },
        ctx.session.turn.id,
        error,
      );
    }
  };
}
