import type { SlackThreadMessage } from "#public/channels/slack/api.js";
import { resolveSlackInboundMrkdwn } from "#public/channels/slack/inbound-content.js";
import { slackMrkdwnToGfm } from "#public/channels/slack/mrkdwn.js";

export function parseThreadMessage(
  raw: Record<string, unknown>,
  threadRootTs: string,
  identity: {
    readonly appId: string | undefined;
    readonly botUserId: string | undefined;
  },
): SlackThreadMessage {
  const topLevelText = typeof raw.text === "string" ? raw.text : "";
  const text = resolveSlackInboundMrkdwn(topLevelText, raw);
  const ts = typeof raw.ts === "string" ? raw.ts : "";
  const threadTs = typeof raw.thread_ts === "string" ? raw.thread_ts : threadRootTs;
  const user = typeof raw.user === "string" ? raw.user : undefined;
  const botId = typeof raw.bot_id === "string" ? raw.bot_id : undefined;
  const appId = typeof raw.app_id === "string" ? raw.app_id : undefined;
  const isMe =
    (identity.botUserId !== undefined && user === identity.botUserId) ||
    (identity.appId !== undefined && appId === identity.appId);
  return {
    text,
    markdown: slackMrkdwnToGfm(text),
    user,
    botId,
    ts,
    threadTs,
    isMe,
    raw,
  };
}
