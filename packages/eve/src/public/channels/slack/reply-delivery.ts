import type { DeliverPayload } from "#channel/types.js";
import { createLogger, logError } from "#internal/logging.js";
import { SLACK_MARKDOWN_TEXT_MAX_LENGTH } from "#public/channels/slack/limits.js";
import type {
  SlackChannelInternalEvents,
  SlackChannelState,
  SlackContext,
  SlackEventContext,
} from "#public/channels/slack/slackChannel.js";

const log = createLogger("slack.reply");
const LONG_RESPONSE_FILENAME = "eve-response.md";
const LONG_RESPONSE_NOTICE = "Here's a snippet with the full response.";

/**
 * Slack error codes for a message payload Slack refused as too large or
 * malformed. Slack posts nothing for a refused call, so uploading the reply
 * as a snippet cannot duplicate it.
 */
const REFUSED_PAYLOAD_ERRORS = new Set([
  "invalid_blocks",
  "invalid_blocks_format",
  "msg_blocks_too_long",
  "msg_blocks_too_many",
  "msg_too_long",
]);

type MessageCompletedHandler = NonNullable<SlackChannelInternalEvents["message.completed"]>;

/**
 * Posts a completed reply to the bound Slack thread the way eve's default
 * renderer does, so an authored renderer can hand a reply back to eve instead
 * of copying its size handling.
 *
 * A reply of up to {@link SLACK_MARKDOWN_TEXT_MAX_LENGTH} characters posts as
 * one native Markdown message. A longer reply uploads unchanged as an
 * `eve-response.md` Markdown snippet with a short note, instead of being
 * truncated or split; this requires the `files:write` bot scope. In a session
 * that has no thread yet, the note posts first and anchors the thread.
 *
 * Throws when Slack rejects the post or the upload. When the throw ends a
 * `message.completed` renderer, the Slack channel still recovers the reply.
 *
 * @example
 * ```ts
 * import { postCompletedSlackReply, SLACK_MARKDOWN_TEXT_MAX_LENGTH } from "eve/channels/slack";
 *
 * if (event.message.length > SLACK_MARKDOWN_TEXT_MAX_LENGTH) {
 *   await postCompletedSlackReply(channel, event.message);
 * } else {
 *   await channel.thread.post({ blocks: answerBlocks(event.message), text: event.message });
 * }
 * ```
 */
export async function postCompletedSlackReply(
  channel: SlackContext,
  message: string,
): Promise<void> {
  if (message.length <= SLACK_MARKDOWN_TEXT_MAX_LENGTH) {
    await channel.thread.post(message);
    return;
  }
  await uploadReplySnippet(channel, message);
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

/**
 * Wraps a channel's composed `message.completed` chain, authored renderers
 * included, so a final reply is never lost without a trace.
 *
 * When the chain throws because Slack refused the payload, eve uploads the
 * reply as a snippet. This assumes the refused call was the reply itself: a
 * renderer that posts the reply and then a separate, refused message gets the
 * reply twice. When the reply still isn't delivered, eve logs the error,
 * posts a short notice with its error id, and tells the model on the next
 * delivery. Steps that end in tool calls and empty replies pass through.
 */
export function withFinalReplyDelivery(
  render: MessageCompletedHandler | undefined,
): MessageCompletedHandler {
  return async (event, channel, ctx) => {
    if (event.finishReason === "tool-calls" || !event.message) {
      await render?.(event, channel, ctx);
      return;
    }
    try {
      await render?.(event, channel, ctx);
    } catch (error) {
      await recoverFinalReply(channel, event.message, event.turnId, error);
    }
  };
}

async function recoverFinalReply(
  channel: SlackEventContext,
  message: string,
  turnId: string,
  error: unknown,
): Promise<void> {
  let failure = error;
  const refusal = refusedPayloadError(error);
  if (refusal !== undefined) {
    log.warn("Slack refused the final reply; uploading it as a snippet", {
      slackError: refusal,
      turnId,
    });
    try {
      await uploadReplySnippet(channel, message);
      return;
    } catch (fallbackError) {
      failure = fallbackError;
    }
  }

  const errorId = logError(log, "final reply was not delivered to Slack", failure, {
    slackError: refusal,
    turnId,
  });
  channel.state.undeliveredReplyErrorId = errorId;
  try {
    await channel.thread.post(
      `I finished, but couldn't deliver my answer in Slack (error id \`${errorId}\`). Please ask me to resend it.`,
    );
  } catch (noticeError) {
    logError(log, "undelivered reply notice failed", noticeError, { errorId, turnId });
  }
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
