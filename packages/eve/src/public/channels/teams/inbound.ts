/**
 * Inbound Microsoft Teams activity parsing and prompt shaping.
 *
 * The channel owns small, documented data shapes instead of exposing the
 * full Bot Framework SDK Activity model as the primary public API.
 */

import TurndownService from "#compiled/turndown/index.js";

import type {
  TeamsAttachment,
  TeamsChannelAccount,
  TeamsMention,
} from "#public/channels/teams/api.js";
import { isNonEmptyString, isObject } from "#shared/guards.js";
import { parseJsonObject } from "#shared/json.js";

/**
 * Normalized Teams conversation scope inferred from the inbound activity's
 * `conversationType`, falling back to `isGroup`. `unknown` is used when neither
 * field identifies the scope, so callers switching over this union must handle it.
 */
export type TeamsConversationScope = "channel" | "groupChat" | "personal" | "unknown";

/** Bot Framework conversation account fields used by the Teams channel. */
export interface TeamsConversationAccount {
  readonly conversationType?: string;
  readonly id: string;
  readonly isGroup?: boolean;
  readonly name?: string;
  readonly tenantId?: string;
}

/** Common fields shared by parsed Teams activities. */
export interface TeamsActivityBase {
  readonly channelData: Record<string, unknown>;
  readonly conversation: TeamsConversationAccount;
  readonly conversationType?: string;
  readonly from: TeamsChannelAccount;
  readonly id: string;
  readonly raw: Record<string, unknown>;
  readonly recipient: TeamsChannelAccount;
  readonly serviceUrl: string;
  readonly tenantId?: string;
  readonly teamId?: string;
  readonly teamsChannelId?: string;
}

/** Parsed Teams message activity. */
export interface TeamsMessageActivity extends TeamsActivityBase {
  readonly attachments: readonly TeamsAttachment[];
  readonly isBotMentioned: boolean;
  readonly mentions: readonly TeamsMention[];
  readonly replyToId?: string;
  readonly scope: TeamsConversationScope;
  readonly text: string;
  readonly textFormat?: string;
  readonly type: "message";
  readonly value?: Record<string, unknown>;
}

/** Parsed Teams invoke activity. */
export interface TeamsInvokeActivity extends TeamsActivityBase {
  readonly name: string;
  readonly replyToId?: string;
  readonly scope: TeamsConversationScope;
  readonly type: "invoke";
  readonly value?: Record<string, unknown>;
}

/** Parsed Teams conversation-update activity. */
export interface TeamsConversationUpdateActivity extends TeamsActivityBase {
  readonly type: "conversationUpdate";
}

/** Parsed Teams activity variants handled by the native channel. */
export type TeamsActivity =
  | TeamsConversationUpdateActivity
  | TeamsInvokeActivity
  | TeamsMessageActivity;

const TEAMS_RESPONSE_INSTRUCTIONS =
  "Reply for Microsoft Teams in concise Markdown. Avoid broad mentions, " +
  "large tables, and messages that need more than a few short posts.";
const HTML_ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&gt;": ">",
  "&lt;": "<",
  "&nbsp;": " ",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
};
const HTML_ENTITY_PATTERN = new RegExp(Object.keys(HTML_ENTITY_MAP).join("|"), "gi");
let turndownService: TurndownService | null = null;

/** Inbound context rendered into the model-visible `<teams_context>` block. */
export interface TeamsInboundContext {
  readonly activityId: string;
  readonly channelId?: string;
  readonly conversationId: string;
  readonly conversationType?: string;
  readonly scope: TeamsConversationScope;
  readonly teamId?: string;
  readonly tenantId?: string;
  readonly userId: string;
  readonly userName?: string;
}

/** Parses one JSON-decoded Teams activity payload. */
export function parseTeamsActivity(value: unknown): TeamsActivity | null {
  if (!isObject(value)) return null;
  if (value.type === "message") return parseMessageActivity(value);
  if (value.type === "invoke") return parseInvokeActivity(value);
  if (value.type === "conversationUpdate") return parseConversationUpdateActivity(value);
  return null;
}

/** Returns true when the message's inferred scope is `personal` (a one-on-one chat with the bot). */
export function isTeamsPersonalMessage(activity: TeamsMessageActivity): boolean {
  return activity.scope === "personal";
}

/** Returns the root activity id that should anchor a Teams thread, when any. */
export function teamsThreadRootActivityId(
  activity: TeamsMessageActivity | TeamsInvokeActivity,
): string | null {
  if (activity.scope === "personal") return null;
  return activity.replyToId ?? activity.id;
}

/**
 * Renders one {@link TeamsInboundContext} as a `<teams_context>` block of
 * `key: value` lines for the model. Optional fields (user name, conversation
 * type, tenant, team, channel) are omitted when absent; field order is stable.
 */
export function formatTeamsContextBlock(context: TeamsInboundContext): string {
  const lines = [
    "<teams_context>",
    "response_medium: microsoft_teams",
    `response_instructions: ${TEAMS_RESPONSE_INSTRUCTIONS}`,
    `user_id: ${context.userId}`,
    ...(context.userName ? [`user_name: ${context.userName}`] : []),
    `conversation_id: ${context.conversationId}`,
    `scope: ${context.scope}`,
    ...(context.conversationType ? [`conversation_type: ${context.conversationType}`] : []),
    ...(context.tenantId ? [`tenant_id: ${context.tenantId}`] : []),
    ...(context.teamId ? [`team_id: ${context.teamId}`] : []),
    ...(context.channelId ? [`channel_id: ${context.channelId}`] : []),
    `activity_id: ${context.activityId}`,
    "</teams_context>",
  ];
  return lines.join("\n");
}

function parseMessageActivity(raw: Record<string, unknown>): TeamsMessageActivity | null {
  const base = parseActivityBase(raw);
  if (!base) return null;
  const mentions = parseMentions(raw.entities);
  const text = normalizeTeamsText(stripBotMention(readText(raw), mentions, base.recipient.id));
  return {
    ...base,
    attachments: parseAttachments(raw.attachments),
    isBotMentioned: mentions.some((mention) => mention.mentioned.id === base.recipient.id),
    mentions,
    replyToId: isNonEmptyString(raw.replyToId) ? raw.replyToId : undefined,
    scope: inferScope(base.conversation),
    text,
    textFormat: isNonEmptyString(raw.textFormat) ? raw.textFormat : undefined,
    type: "message",
    value: isObject(raw.value) ? raw.value : undefined,
  };
}

function parseInvokeActivity(raw: Record<string, unknown>): TeamsInvokeActivity | null {
  const base = parseActivityBase(raw);
  if (!base || !isNonEmptyString(raw.name)) return null;
  return {
    ...base,
    name: raw.name,
    replyToId: isNonEmptyString(raw.replyToId) ? raw.replyToId : undefined,
    scope: inferScope(base.conversation),
    type: "invoke",
    value: isObject(raw.value) ? raw.value : undefined,
  };
}

function parseConversationUpdateActivity(
  raw: Record<string, unknown>,
): TeamsConversationUpdateActivity | null {
  const base = parseActivityBase(raw);
  if (!base) return null;
  return {
    ...base,
    type: "conversationUpdate",
  };
}

function parseActivityBase(raw: Record<string, unknown>): TeamsActivityBase | null {
  if (!isNonEmptyString(raw.serviceUrl)) return null;
  const conversation = parseConversation(raw.conversation);
  const from = parseChannelAccount(raw.from);
  const recipient = parseChannelAccount(raw.recipient);
  if (!conversation || !from || !recipient) return null;

  const channelData = isObject(raw.channelData) ? raw.channelData : {};
  const tenantId = readNestedString(channelData, ["tenant", "id"]) ?? conversation.tenantId;
  const teamId = readNestedString(channelData, ["team", "id"]);
  const teamsChannelId = readNestedString(channelData, ["channel", "id"]);

  return {
    channelData,
    conversation,
    conversationType: conversation.conversationType,
    from,
    id: isNonEmptyString(raw.id) ? raw.id : "",
    raw,
    recipient,
    serviceUrl: raw.serviceUrl,
    tenantId,
    teamId,
    teamsChannelId,
  };
}

function parseConversation(value: unknown): TeamsConversationAccount | null {
  if (!isObject(value) || !isNonEmptyString(value.id)) return null;
  return {
    conversationType: isNonEmptyString(value.conversationType) ? value.conversationType : undefined,
    id: value.id,
    isGroup: typeof value.isGroup === "boolean" ? value.isGroup : undefined,
    name: isNonEmptyString(value.name) ? value.name : undefined,
    tenantId: isNonEmptyString(value.tenantId) ? value.tenantId : undefined,
  };
}

function parseChannelAccount(value: unknown): TeamsChannelAccount | null {
  if (!isObject(value) || !isNonEmptyString(value.id)) return null;
  return {
    aadObjectId: isNonEmptyString(value.aadObjectId) ? value.aadObjectId : undefined,
    id: value.id,
    name: isNonEmptyString(value.name) ? value.name : undefined,
    role: isNonEmptyString(value.role) ? value.role : undefined,
  };
}

function parseMentions(value: unknown): TeamsMention[] {
  if (!Array.isArray(value)) return [];
  const mentions: TeamsMention[] = [];
  for (const entity of value) {
    if (!isObject(entity) || entity.type !== "mention" || !isNonEmptyString(entity.text)) {
      continue;
    }
    const mentioned = parseChannelAccount(entity.mentioned);
    if (!mentioned) continue;
    mentions.push({
      mentioned,
      text: entity.text,
      type: "mention",
    });
  }
  return mentions;
}

function parseAttachments(value: unknown): TeamsAttachment[] {
  if (!Array.isArray(value)) return [];
  const attachments: TeamsAttachment[] = [];
  for (const attachment of value) {
    if (!isObject(attachment) || !isNonEmptyString(attachment.contentType)) continue;
    const result: TeamsAttachment = {
      content: isObject(attachment.content) ? parseJsonObject(attachment.content) : undefined,
      contentType: attachment.contentType,
      contentUrl: isNonEmptyString(attachment.contentUrl) ? attachment.contentUrl : undefined,
      name: isNonEmptyString(attachment.name) ? attachment.name : undefined,
    };
    attachments.push(result);
  }
  return attachments;
}

function inferScope(conversation: TeamsConversationAccount): TeamsConversationScope {
  const type = conversation.conversationType;
  if (type === "personal" || type === "groupChat" || type === "channel") return type;
  if (conversation.isGroup === true) return "groupChat";
  if (conversation.isGroup === false) return "personal";
  return "unknown";
}

function readText(raw: Record<string, unknown>): string {
  return typeof raw.text === "string" ? raw.text : "";
}

function stripBotMention(text: string, mentions: readonly TeamsMention[], botId: string): string {
  let result = text;
  for (const mention of mentions) {
    if (mention.mentioned.id !== botId) continue;
    result = result.replace(mention.text, "");
  }
  return result.trim();
}

function normalizeTeamsText(text: string): string {
  const value = text.trim();
  if (!looksLikeHtml(value)) return decodeHtmlEntities(value);

  return getTurndownService()
    .turndown(value.replace(/<at>(.*?)<\/at>/gi, "@$1"))
    .replace(/ {2}\n/g, "\n")
    .trim();
}

function readNestedString(
  value: Record<string, unknown>,
  path: readonly string[],
): string | undefined {
  let current: unknown = value;
  for (const segment of path) {
    if (!isObject(current)) return undefined;
    current = current[segment];
  }
  return isNonEmptyString(current) ? current : undefined;
}

function looksLikeHtml(value: string): boolean {
  return /<\/?[a-z][\s\S]*>/i.test(value);
}

function decodeHtmlEntities(value: string): string {
  return value.replace(
    HTML_ENTITY_PATTERN,
    (match) => HTML_ENTITY_MAP[match.toLowerCase()] ?? match,
  );
}

function getTurndownService(): TurndownService {
  turndownService ??= new TurndownService({
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
    headingStyle: "atx",
    hr: "---",
  });
  return turndownService;
}
