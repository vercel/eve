import type { SlackApiResponse } from "#public/channels/slack/api.js";
import { createSlackLookupCache } from "#public/channels/slack/lookup-cache.js";
import { readSlackSpaceType } from "#public/channels/slack/space.js";
import type {
  ConversationSpaceType,
  ConversationSpaceVisibility,
} from "#shared/conversation-context.js";

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

export interface SlackConversationKind {
  readonly isPrivate: boolean;
  readonly spaceType?: ConversationSpaceType;
  readonly visibility?: ConversationSpaceVisibility;
}

export type SlackConversationKindReader = (input: {
  readonly channelId: string;
  readonly raw: Readonly<Record<string, unknown>> | undefined;
  readonly request: (operation: string, body: unknown) => Promise<SlackApiResponse>;
  readonly teamId?: string;
}) => Promise<SlackConversationKind>;

const CONVERSATION_KIND_TTL_MS = 5 * 60 * 1000;
const FAILED_CONVERSATION_KIND_TTL_MS = 60_000;

export function createSlackConversationKindReader(now?: () => number): SlackConversationKindReader {
  const cache = createSlackLookupCache<SlackConversationKind>({
    failedTtlMs: FAILED_CONVERSATION_KIND_TTL_MS,
    now,
    ttlMs: CONVERSATION_KIND_TTL_MS,
  });

  return (input) => {
    const fromEvent = readEventConversationKind(input.raw);
    if (fromEvent !== undefined) return Promise.resolve(fromEvent);

    const key = `${input.teamId ?? ""}:${input.channelId}`;
    return cache.getOrLoad(key, async () => {
      const value = await fetchSlackConversationKind(input.channelId, input.request);
      return { failed: value.visibility === undefined, value };
    });
  };
}

export async function readSlackConversationKind(input: {
  readonly channelId: string;
  readonly raw: Readonly<Record<string, unknown>> | undefined;
  readonly request: (operation: string, body: unknown) => Promise<SlackApiResponse>;
}): Promise<SlackConversationKind> {
  const fromEvent = readEventConversationKind(input.raw);
  if (fromEvent !== undefined) return fromEvent;
  return await fetchSlackConversationKind(input.channelId, input.request);
}

function readEventConversationKind(
  raw: Readonly<Record<string, unknown>> | undefined,
): SlackConversationKind | undefined {
  const eventPrivacy = readSlackConversationPrivacy(raw);
  if (eventPrivacy === "unknown") return undefined;
  const spaceType = readSlackSpaceType(raw);
  return {
    isPrivate: eventPrivacy === "private",
    ...(spaceType && { spaceType }),
    visibility: eventPrivacy,
  };
}

async function fetchSlackConversationKind(
  channelId: string,
  request: (operation: string, body: unknown) => Promise<SlackApiResponse>,
): Promise<SlackConversationKind> {
  try {
    const response = await request("conversations.info", { channel: channelId });
    const privacy = readConversationInfoPrivacy(response);
    const spaceType = readConversationInfoSpaceType(response);
    return {
      isPrivate: privacy === "unknown" || privacy === "private",
      ...(spaceType && { spaceType }),
      ...(privacy !== "unknown" && { visibility: privacy }),
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
  return channel.is_mpim === true ||
    channel.is_channel === true ||
    channel.is_group === true ||
    typeof channel.is_private === "boolean"
    ? "shared"
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
