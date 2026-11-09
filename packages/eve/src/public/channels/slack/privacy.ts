import type { SlackApiResponse } from "#public/channels/slack/api.js";
import { readSlackSpaceType } from "#public/channels/slack/space.js";
import type { ConversationSpaceType } from "#shared/conversation-context.js";

type SlackConversationPrivacy = "private" | "public" | "unknown";

export function readSlackConversationPrivacy(
  raw: Readonly<Record<string, unknown>> | undefined,
): SlackConversationPrivacy {
  switch (raw?.channel_type) {
    case "im":
    case "mpim":
    case "group":
      return "private";
    case "channel":
      return "public";
    default:
      return "unknown";
  }
}

/** What eve knows about a Slack conversation: whether it is private, and what kind of space it is. */
export interface SlackConversationKind {
  readonly isPrivate: boolean;
  readonly spaceType?: ConversationSpaceType;
}

/**
 * Classifies a conversation from the event's `channel_type`, or from
 * `conversations.info` when the event has none, as `app_mention` events don't.
 * Unknown conversations fail closed as private.
 */
export async function readSlackConversationKind(input: {
  readonly channelId: string;
  readonly raw: Readonly<Record<string, unknown>> | undefined;
  readonly request: (operation: string, body: unknown) => Promise<SlackApiResponse>;
}): Promise<SlackConversationKind> {
  const eventPrivacy = readSlackConversationPrivacy(input.raw);
  if (eventPrivacy !== "unknown") {
    const spaceType = readSlackSpaceType(input.raw);
    return { isPrivate: eventPrivacy === "private", ...(spaceType && { spaceType }) };
  }

  try {
    const response = await input.request("conversations.info", { channel: input.channelId });
    const privacy = readConversationInfoPrivacy(response);
    const spaceType = readConversationInfoSpaceType(response);
    return {
      isPrivate: privacy === "unknown" || privacy === "private",
      ...(spaceType && { spaceType }),
    };
  } catch {
    return { isPrivate: true };
  }
}

export async function isPrivateSlackConversation(
  input: Parameters<typeof readSlackConversationKind>[0],
): Promise<boolean> {
  return (await readSlackConversationKind(input)).isPrivate;
}

function readConversationInfoSpaceType(
  response: SlackApiResponse,
): ConversationSpaceType | undefined {
  if (response.ok !== true || !isRecord(response.channel)) return undefined;
  const channel = response.channel;
  if (channel.is_im === true) return "direct";
  if (channel.is_mpim === true) return "group";
  return channel.is_channel === true ||
    channel.is_group === true ||
    typeof channel.is_private === "boolean"
    ? "channel"
    : undefined;
}

function readConversationInfoPrivacy(response: SlackApiResponse): SlackConversationPrivacy {
  if (response.ok !== true || !isRecord(response.channel)) return "unknown";

  const channel = response.channel;
  if (channel.is_im === true || channel.is_mpim === true || channel.is_private === true) {
    return "private";
  }
  return channel.is_private === false ? "public" : "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
