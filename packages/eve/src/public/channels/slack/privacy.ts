import type { SlackApiResponse } from "#public/channels/slack/api.js";

export type SlackConversationPrivacy = "private" | "public" | "unknown";

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

export async function isPrivateSlackConversation(input: {
  readonly channelId: string;
  readonly raw: Readonly<Record<string, unknown>> | undefined;
  readonly request: (operation: string, body: unknown) => Promise<SlackApiResponse>;
}): Promise<boolean> {
  const eventPrivacy = readSlackConversationPrivacy(input.raw);
  if (eventPrivacy !== "unknown") return eventPrivacy === "private";

  try {
    const privacy = readConversationInfoPrivacy(
      await input.request("conversations.info", { channel: input.channelId }),
    );
    return privacy === "unknown" || privacy === "private";
  } catch {
    return true;
  }
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
