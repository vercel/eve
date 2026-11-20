import type { SlackThreadMessage } from "#public/channels/slack/api.js";
import type { SlackInboundContext } from "#public/channels/slack/inbound.js";
import { slackMrkdwnToGfm } from "#public/channels/slack/mrkdwn.js";
import type { SlackUserInfo } from "#public/channels/slack/user-info.js";
import { diffLines } from "#shared/line-diff.js";
import type { SessionHistoryMessage } from "#shared/session-history.js";

interface SlackModelMessageInput {
  readonly botUserId?: string;
  readonly channelId?: string;
  readonly content: string;
  readonly isMentioned?: boolean;
  readonly senderId?: string;
  readonly senderInfo?: SlackUserInfo;
  readonly senderType: "agent" | "bot" | "unknown" | "user";
  readonly teamId?: string;
  readonly threadTs: string;
  readonly ts: string;
  readonly editLines?: readonly string[];
  readonly guidance?: string;
}

function formatSlackModelMessage(input: SlackModelMessageInput): string {
  const info = input.senderInfo;
  const botLines = [
    ...(input.botUserId ? [`id: ${input.botUserId}`] : []),
    ...(input.isMentioned !== undefined ? [`mentioned: ${input.isMentioned}`] : []),
  ];
  const tag = input.editLines === undefined ? "slack_message" : "slack_message_edit";
  const guidance = input.guidance?.trim();
  return [
    `<${tag}>`,
    "<sender>",
    `type: ${input.senderType}`,
    ...(input.senderId ? [`id: ${input.senderId}`] : []),
    ...(info?.displayName ? [`display_name: ${oneLine(info.displayName)}`] : []),
    ...(info?.realName ? [`real_name: ${oneLine(info.realName)}`] : []),
    ...(info?.email ? [`email: ${oneLine(info.email)}`] : []),
    "</sender>",
    ...(botLines.length > 0 ? ["<bot>", ...botLines, "</bot>"] : []),
    "<thread>",
    ...(input.teamId ? [`team_id: ${input.teamId}`] : []),
    ...(input.channelId ? [`channel_id: ${input.channelId}`] : []),
    `thread_ts: ${input.threadTs}`,
    `message_ts: ${input.ts}`,
    "</thread>",
    ...(input.editLines ?? []),
    ...(guidance ? ["<guidance>", neutralizeBlockTags(guidance), "</guidance>"] : []),
    "<content>",
    neutralizeBlockTags(input.content),
    "</content>",
    `</${tag}>`,
  ].join("\n");
}

function oneLine(value: string): string {
  return neutralizeBlockTags(value.replace(/[\r\n]+/gu, " "));
}

const BLOCK_TAG =
  /<(?=\s*\/?\s*(?:slack_message_edit|slack_message|slack_thread_context|sender|bot|thread|edit|diff|guidance|content)\b)/giu;

function neutralizeBlockTags(value: string): string {
  return value.replace(BLOCK_TAG, "&lt;");
}

export function formatSlackInboundMessage(
  context: SlackInboundContext,
  message: InboundMessageInput,
): string {
  return formatSlackModelMessage(inboundModelMessage(context, message));
}

export function formatSlackInboundMessageEdit(
  context: SlackInboundContext,
  edit: InboundMessageInput & {
    readonly previousText: string | undefined;
    readonly editedTs: string;
  },
): string {
  const content = slackModelContent(edit.text);
  const diff =
    edit.previousText === undefined
      ? undefined
      : changedLines(slackModelContent(edit.previousText), content);
  const reason =
    edit.previousText === undefined
      ? "unavailable, Slack did not include the text before the edit"
      : "omitted, the message is too long to compare";
  return formatSlackModelMessage({
    ...inboundModelMessage(context, edit),
    content,
    editLines: [
      "<edit>",
      `edited_ts: ${edit.editedTs}`,
      ...(diff === undefined ? [`diff: ${reason}`] : []),
      "</edit>",
      ...(diff === undefined ? [] : ["<diff>", neutralizeBlockTags(diff), "</diff>"]),
    ],
  });
}

interface InboundMessageInput {
  readonly text: string;
  readonly ts: string;
  readonly guidance?: string;
}

function inboundModelMessage(
  context: SlackInboundContext,
  message: InboundMessageInput,
): SlackModelMessageInput {
  const senderInfo: SlackUserInfo = {
    ...(context.displayName && { displayName: context.displayName }),
    ...(context.fullName && { realName: context.fullName }),
    ...(context.email && { email: context.email }),
  };
  return {
    botUserId: context.botUserId,
    channelId: context.channelId,
    content: slackModelContent(message.text),
    guidance: message.guidance,
    isMentioned: context.isMentioned,
    senderId: context.userId || undefined,
    senderInfo,
    senderType: context.userId ? "user" : "unknown",
    teamId: context.teamId,
    threadTs: context.threadTs,
    ts: message.ts,
  };
}

function changedLines(before: string, after: string): string | undefined {
  return diffLines(before.split("\n"), after.split("\n"))
    ?.flatMap(({ kind, text }) =>
      kind === undefined ? [] : [`${kind === "added" ? "+" : "-"}${text}`],
    )
    .join("\n");
}

function slackModelContent(input: string): string {
  const mentions: string[] = [];
  let markerPrefix = "\uE000eve_slack_user_mention_";
  while (input.includes(markerPrefix)) markerPrefix += "_";

  const protectedInput = input.replace(/<@[A-Z0-9_]+(?:\|[^>\r\n]+)?>/giu, (mention) => {
    const marker = `${markerPrefix}${mentions.length}\uE001`;
    mentions.push(mention);
    return marker;
  });
  let markdown = slackMrkdwnToGfm(protectedInput);
  for (const [index, mention] of mentions.entries()) {
    markdown = markdown.replaceAll(`${markerPrefix}${index}\uE001`, mention);
  }
  return markdown;
}

export function formatSlackThreadContext(
  messages: readonly SlackThreadMessage[],
  users?: ReadonlyMap<string, SlackUserInfo>,
): string | undefined {
  if (messages.length === 0) return undefined;

  return [
    "<slack_thread_context>",
    ...messages.map((message) => formatSlackThreadMessage(message, users)),
    "</slack_thread_context>",
  ].join("\n");
}

function formatSlackThreadMessage(
  message: SlackThreadMessage,
  users: ReadonlyMap<string, SlackUserInfo> | undefined,
): string {
  return formatSlackModelMessage({
    content: message.markdown,
    senderId: message.user ?? message.botId,
    senderInfo: message.user ? users?.get(message.user) : undefined,
    senderType: slackThreadSenderType(message),
    threadTs: message.threadTs,
    ts: message.ts,
  });
}

function slackThreadSenderType(message: SlackThreadMessage): SlackModelMessageInput["senderType"] {
  if (message.isMe) return "agent";
  if (message.botId) return "bot";
  if (message.user) return "user";
  return "unknown";
}

export function slackThreadSessionHistory(
  messages: readonly SlackThreadMessage[],
  users?: ReadonlyMap<string, SlackUserInfo>,
): SessionHistoryMessage[] {
  return messages.flatMap((message) => slackThreadHistoryMessage(message, users) ?? []);
}

function slackThreadHistoryMessage(
  message: SlackThreadMessage,
  users: ReadonlyMap<string, SlackUserInfo> | undefined,
): SessionHistoryMessage | undefined {
  if (message.markdown.trim().length === 0) return undefined;
  if (message.isMe) return { id: message.ts, role: "assistant", text: message.markdown };
  return { id: message.ts, role: "user", text: formatSlackThreadMessage(message, users) };
}
