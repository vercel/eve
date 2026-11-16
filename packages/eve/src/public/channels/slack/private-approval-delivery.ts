import { createLogger, logError } from "#internal/logging.js";
import type { SlackHandle, SlackThread } from "#public/channels/slack/api.js";
import type { BlockKitBlock } from "#public/channels/slack/blocks.js";
import type {
  SlackCardMessage,
  SlackInteractionCardParts,
} from "#public/channels/slack/renderers.js";
import {
  type RenderedRequestCard,
  sendWithFallback,
} from "#public/channels/slack/request-card-render.js";

const log = createLogger("slack.private-approval-delivery");
type PrivateApprovalSlack = Pick<SlackHandle, "channelId" | "request" | "threadTs">;

/** Where a private request's messages landed. */
export interface PrivateInteractionDelivery {
  readonly channelId: string;
  readonly ts: string;
  readonly detailsTs?: string;
  /** The controls blocks posted: the rendered ones, or eve's default if Slack rejected them. */
  readonly blocks: readonly BlockKitBlock[];
}

/**
 * Posts one rendered request to `reviewer`'s DM: a permalink to the thread, its details, then
 * its controls. A failure deletes what it posted, so a reviewer never sees half a request.
 */
export async function deliverPrivateInteraction(input: {
  readonly previewMessageTs: string;
  readonly card: RenderedRequestCard;
  readonly reviewer: string;
  readonly slack: PrivateApprovalSlack;
}): Promise<PrivateInteractionDelivery> {
  const open = await input.slack.request("conversations.open", { users: input.reviewer });
  const channelId =
    open.ok === true ? (open.channel as { id?: unknown } | undefined)?.id : undefined;
  if (typeof channelId !== "string" || channelId.length === 0) {
    throw new Error(`Slack conversations.open failed: ${open.error ?? "unknown_error"}`);
  }

  const { fallback, parts } = input.card;
  const postedMessageIds: string[] = [];
  const post = async (body: Record<string, unknown>): Promise<string> => {
    const ts = await postMessage(input.slack, {
      channel: channelId,
      unfurl_links: false,
      unfurl_media: false,
      ...body,
    });
    postedMessageIds.push(ts);
    return ts;
  };
  const postPart = async (message: SlackCardMessage) => {
    const ts = await post({ blocks: message.blocks, text: message.text });
    return { blocks: message.blocks, ts };
  };

  try {
    const permalink = await resolveMessagePermalink(input.slack, input.previewMessageTs);
    if (permalink !== undefined) {
      await post({ markdown_text: permalink, unfurl_links: true });
    }
    const details =
      parts.details === undefined
        ? undefined
        : await sendWithFallback(postPart, parts.details, fallback.details);
    const controls = (await sendWithFallback(postPart, parts.controls, fallback.controls))!;
    const delivery: {
      -readonly [K in keyof PrivateInteractionDelivery]: PrivateInteractionDelivery[K];
    } = { blocks: controls.blocks, channelId, ts: controls.ts };
    if (details !== undefined) delivery.detailsTs = details.ts;
    return delivery;
  } catch (error) {
    await Promise.allSettled(
      postedMessageIds.map(async (ts) => {
        try {
          await input.slack.request("chat.delete", { channel: channelId, ts });
        } catch (cleanupError) {
          logError(log, "failed to roll back partial private approval delivery", cleanupError, {
            channelId,
            messageTs: ts,
          });
        }
      }),
    );
    throw error;
  }
}

/**
 * Posts one rendered request as an ephemeral message only `reviewer` sees in the session's
 * thread. Details and controls go in one message: Slack can't edit or delete an ephemeral, so a
 * separate details message could never be retired.
 */
export async function deliverEphemeralInteraction(input: {
  readonly card: RenderedRequestCard;
  readonly channelId: string;
  readonly reviewer: string;
  readonly thread: Pick<SlackThread, "postEphemeral">;
}): Promise<PrivateInteractionDelivery> {
  const send = async (message: SlackCardMessage) => {
    const posted = await input.thread.postEphemeral(input.reviewer, {
      blocks: [...message.blocks],
      text: message.text,
    });
    return { blocks: message.blocks, ts: posted.id };
  };
  const { fallback, parts } = input.card;
  const posted = (await sendWithFallback(send, oneMessage(parts), oneMessage(fallback)))!;
  return { blocks: posted.blocks, channelId: input.channelId, ts: posted.ts };
}

function oneMessage({ controls, details }: SlackInteractionCardParts): SlackCardMessage {
  return details === undefined
    ? controls
    : { blocks: [...details.blocks, ...controls.blocks], text: controls.text };
}

async function resolveMessagePermalink(
  slack: Pick<SlackHandle, "channelId" | "request">,
  messageTs: string,
): Promise<string | undefined> {
  if (!slack.channelId || !messageTs) return undefined;
  const response = await slack.request("chat.getPermalink", {
    channel: slack.channelId,
    message_ts: messageTs,
  });
  return response.ok === true && typeof response.permalink === "string"
    ? response.permalink
    : undefined;
}

async function postMessage(
  slack: Pick<SlackHandle, "request">,
  body: Record<string, unknown>,
): Promise<string> {
  const response = await slack.request("chat.postMessage", body);
  if (response.ok !== true || typeof response.ts !== "string" || response.ts.length === 0) {
    // `response` carries Slack's error code, which decides whether eve's default is worth sending.
    throw Object.assign(
      new Error(`Slack chat.postMessage failed: ${response.error ?? "unknown_error"}`),
      { response },
    );
  }
  return response.ts;
}
