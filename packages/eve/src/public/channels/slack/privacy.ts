import type { SlackApiResponse } from "#public/channels/slack/api.js";
import type { ChannelAudience } from "#shared/channel-audience.js";

interface SlackConversationInput {
  readonly channelId: string;
  readonly raw?: Readonly<Record<string, unknown>>;
  readonly request: (operation: string, body: unknown) => Promise<SlackApiResponse>;
}

export function readSlackConversationPrivacy(
  raw: Readonly<Record<string, unknown>> | undefined,
): ChannelAudience {
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

export async function resolveSlackConversationPrivacy(
  input: SlackConversationInput,
): Promise<ChannelAudience> {
  const eventPrivacy = readSlackConversationPrivacy(input.raw);
  if (eventPrivacy !== "unknown") return eventPrivacy;

  try {
    return readConversationInfoPrivacy(
      await input.request("conversations.info", { channel: input.channelId }),
    );
  } catch {
    return "unknown";
  }
}

export async function isPrivateSlackConversation(input: SlackConversationInput): Promise<boolean> {
  return (await resolveSlackConversationPrivacy(input)) !== "public";
}

function readConversationInfoPrivacy(response: SlackApiResponse): ChannelAudience {
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
