import { replyTextOf } from "#public/channels/reply.js";
import type { DeliverPayload } from "#channel/types.js";
import { createLogger, logError } from "#internal/logging.js";
import {
  SLACK_MARKDOWN_TEXT_MAX_LENGTH,
  truncateMessageText,
} from "#public/channels/slack/limits.js";
import type {
  SlackChannelInternalEvents,
  SlackChannelState,
  SlackContext,
  SlackEventContext,
} from "#public/channels/slack/slackChannel.js";

const log = createLogger("slack.reply");
const LONG_RESPONSE_FILENAME = "eve-response.md";
const LONG_RESPONSE_NOTICE = "Here's a snippet with the full response.";
const FALLBACK_LOG = "Slack refused the final reply; delivering it with a fallback";

/**
 * Slack error codes for a message payload Slack refused as too large or
 * malformed. Slack posts nothing for a refused call, so a fallback post
 * cannot duplicate it.
 */
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

/**
 * {@link postCompletedSlackReply} with fields for its fallback log, such as
 * the turn id eve's default renderer knows.
 */
export async function deliverCompletedSlackReply(
  channel: SlackContext,
  reply: SlackCompletedReply,
  logFields: { readonly turnId?: string },
): Promise<void> {
  const { blocks, markdown, text } = typeof reply === "string" ? { markdown: reply } : reply;
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

async function uploadReplySnippet(channel: SlackContext, message: string): Promise<void> {
  const file = {
    data: new Blob([message], { type: "text/markdown" }),
    filename: LONG_RESPONSE_FILENAME,
    mimeType: "text/markdown",
  };

  const hasThread = channel.slack.threadTs.length > 0;
  if (!hasThread) {
    // Uploads cannot anchor proactive sessions; post the notice first.
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

/** Slack's error code when `error` is a refused-payload error, checking its causes. */
function refusedPayloadError(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    const candidate = current as {
      readonly cause?: unknown;
      readonly data?: { readonly error?: unknown };
      readonly response?: { readonly error?: unknown };
    };
    // eve's Slack client reports the code on `response`; `@slack/web-api` on `data`.
    const code = candidate.response?.error ?? candidate.data?.error;
    if (typeof code === "string" && REFUSED_PAYLOAD_ERRORS.has(code)) return code;
    current = candidate.cause;
  }
  return undefined;
}

/**
 * Wraps a channel's composed `message.completed` chain, authored renderers
 * included, so a final reply that fails is never lost without a trace.
 *
 * When the chain throws on a final reply, eve logs the error at error level,
 * posts a content-free notice with its error id, and tells the model on the
 * next delivery that its reply was not seen. eve never sends the reply from
 * here: the chain owns the content, including any change a renderer made
 * before `next`, and {@link postCompletedSlackReply} owns the fallbacks.
 * Narration, other content, and empty replies pass through.
 */
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
      await reportUndeliveredReply(ctx.channel, ctx.session.turn.id, error);
    }
  };
}

async function reportUndeliveredReply(
  channel: SlackEventContext,
  turnId: string,
  error: unknown,
): Promise<void> {
  const errorId = logError(log, "final reply was not delivered to Slack", error, { turnId });
  channel.state.undeliveredReplyErrorId = errorId;
  try {
    await channel.thread.post(
      `I finished, but couldn't deliver my answer in Slack (error id \`${errorId}\`). Please ask me to resend it.`,
    );
  } catch (noticeError) {
    logError(log, "undelivered reply notice failed", noticeError, { errorId, turnId });
  }
}

/**
 * Tells the model, ahead of the next message, that its previous reply never
 * reached Slack, so it does not assume the user read that reply.
 */
export function withUndeliveredReplyNote<T extends DeliverPayload>(
  state: SlackChannelState,
  payload: T,
): T {
  const errorId = state.undeliveredReplyErrorId;
  if (!errorId || payload.message === undefined) return payload;
  state.undeliveredReplyErrorId = null;
  const note = [
    `Your previous reply was not delivered to Slack (error id ${errorId}).`,
    "The user has not seen it. Do not assume they read it; send the answer again if they ask for it.",
  ].join(" ");
  return { ...payload, context: [note, ...(payload.context ?? [])] };
}
