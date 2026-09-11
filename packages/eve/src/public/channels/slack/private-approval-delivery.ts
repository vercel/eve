import { createLogger, logError } from "#internal/logging.js";
import type { SlackHandle } from "#public/channels/slack/api.js";
import { renderInputRequestPostParts } from "#public/channels/slack/hitl.js";
import type { SlackPendingApprovalCard } from "#public/channels/slack/slackChannel.js";
import type { InputRequest } from "#shared/input.js";

const log = createLogger("slack.private-approval-delivery");
type PrivateApprovalSlack = Pick<SlackHandle, "channelId" | "request" | "threadTs">;

export async function deliverPrivateInputRequest(input: {
  readonly previewMessageTs: string;
  readonly request: InputRequest;
  readonly reviewer: string;
  readonly slack: PrivateApprovalSlack;
}): Promise<SlackPendingApprovalCard> {
  const open = await input.slack.request("conversations.open", { users: input.reviewer });
  const messageChannelId =
    open.ok === true ? (open.channel as { id?: unknown } | undefined)?.id : undefined;
  if (typeof messageChannelId !== "string" || messageChannelId.length === 0) {
    throw new Error(`Slack conversations.open failed: ${open.error ?? "unknown_error"}`);
  }

  const parts = renderInputRequestPostParts(input.request, {
    returnTo: {
      channelId: input.slack.channelId,
      threadTs: input.slack.threadTs,
    },
  });
  const postedMessageIds: string[] = [];

  try {
    const permalink = await resolveMessagePermalink(input.slack, input.previewMessageTs);
    if (permalink !== undefined) {
      postedMessageIds.push(
        await postMessage(input.slack, {
          channel: messageChannelId,
          markdown_text: permalink,
          unfurl_links: true,
          unfurl_media: false,
        }),
      );
    }
    if (parts.details !== undefined) {
      postedMessageIds.push(
        await postMessage(input.slack, {
          blocks: parts.details.blocks,
          channel: messageChannelId,
          text: parts.details.text,
          unfurl_links: false,
          unfurl_media: false,
        }),
      );
    }
    const messageTs = await postMessage(input.slack, {
      blocks: parts.controls.blocks,
      channel: messageChannelId,
      text: parts.controls.text,
      unfurl_links: false,
      unfurl_media: false,
    });
    postedMessageIds.push(messageTs);
    return { messageBlocks: parts.controls.blocks, messageChannelId, messageTs };
  } catch (error) {
    await Promise.allSettled(
      postedMessageIds.map(async (ts) => {
        try {
          await input.slack.request("chat.delete", { channel: messageChannelId, ts });
        } catch (cleanupError) {
          logError(log, "failed to roll back partial private approval delivery", cleanupError, {
            channelId: messageChannelId,
            messageTs: ts,
          });
        }
      }),
    );
    throw error;
  }
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
    throw new Error(`Slack chat.postMessage failed: ${response.error ?? "unknown_error"}`);
  }
  return response.ts;
}
