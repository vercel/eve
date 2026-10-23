import type { ChannelFrom } from "eve/channels";
import {
  slackContinuationToken,
  type SlackChannel,
  type SlackChannelState,
  type SlackMessage,
} from "eve/channels/slack";
import type { SessionAuthContext } from "eve/context";

/**
 * Slack Code Channels: https://docs.slack.dev/ai/slack-code
 *
 * A code channel is one task, so the whole channel is one eve session. eve
 * keys Slack sessions by thread, so every message in a code channel is routed
 * to a single channel-wide address, `<channelId>:0`, and the renderer posts
 * replies top-level instead of in a thread.
 */
export const CHANNEL_SESSION_THREAD = "0";

/** Session auth attribute that marks a turn as belonging to a code channel. */
const CODE_CHANNEL_ATTRIBUTE = "code_channel_id";

export type SlackCall = (
  operation: string,
  body: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/** "open a code channel for this", "move this to slack code", ... */
export function asksForCodeChannel(text: string): boolean {
  return /\b(code[- ]?channel|slack code)\b/i.test(text);
}

export function isCodeChannelSession(state: SlackChannelState): boolean {
  return state.threadTs === CHANNEL_SESSION_THREAD;
}

export function codeChannelAuth(auth: SessionAuthContext, channelId: string): SessionAuthContext {
  return { ...auth, attributes: { ...auth.attributes, [CODE_CHANNEL_ATTRIBUTE]: channelId } };
}

/** The code channel the current turn belongs to, plus its Slack workspace. */
export function currentCodeChannel(auth: SessionAuthContext | null | undefined) {
  const channelId = auth?.attributes[CODE_CHANNEL_ATTRIBUTE];
  const teamId = auth?.attributes.team_id;
  return typeof channelId === "string" && typeof teamId === "string"
    ? { channelId, teamId }
    : undefined;
}

/**
 * Calls an `agents.conversations.*` method. Workspaces from the Slack Code
 * preview only know the earlier `codeChannels.*` names, so retry with those.
 */
export async function codeChannelApi(
  call: SlackCall,
  operation: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let result = await call(operation, body);
  if (result.error === "unknown_method" && operation.startsWith("agents.conversations.")) {
    result = await call(operation.replace("agents.conversations.", "codeChannels."), body);
  }
  if (result.ok !== true) {
    throw new Error(`Slack ${operation} failed: ${String(result.error ?? "invalid_response")}`);
  }
  return result;
}

export function setSessionStatus(
  call: SlackCall,
  channelId: string,
  status: "processing" | "active",
): Promise<Record<string, unknown>> {
  // A code channel is one session, so `agents.sessions.setStatus` takes no `thread_ts`.
  return codeChannelApi(call, "agents.sessions.setStatus", { channel_id: channelId, status });
}

const codeChannels = new Map<string, boolean>();

/**
 * Whether `channelId` is a code channel this app may work in. Slack marks code
 * channels with `properties.record_channel.record_type === "agent_channel"`.
 * Shared channels are refused because they can include people from outside
 * the workspace.
 */
export async function isCodeChannel(call: SlackCall, channelId: string): Promise<boolean> {
  if (!channelId.startsWith("C") && !channelId.startsWith("G")) return false;
  const cached = codeChannels.get(channelId);
  if (cached !== undefined) return cached;

  const response = await call("conversations.info", { channel: channelId });
  if (response.ok !== true) throw new Error(`Slack conversations.info failed: ${response.error}`);
  const channel = asRecord(response.channel);
  const properties = asRecord(channel?.properties);
  const result =
    asRecord(properties?.record_channel)?.record_type === "agent_channel" &&
    channel?.is_shared !== true &&
    channel?.is_ext_shared !== true &&
    channel?.is_org_shared !== true;
  codeChannels.set(channelId, result);
  return result;
}

/** Creates a code channel from the message that asked for it. Returns its ID. */
export async function createCodeChannel(
  call: SlackCall,
  input: { title: string; originChannelId: string; originMessageTs: string },
): Promise<string> {
  const result = await codeChannelApi(call, "agents.conversations.create", {
    name: input.title.slice(0, 80),
    // Slack's idempotency key: a retried webhook reuses the same channel.
    session_id: `${input.originChannelId}-${input.originMessageTs}`.slice(0, 64),
    origin_channel_id: input.originChannelId,
    origin_message_ts: input.originMessageTs,
  });
  const channelId = result.channel_id;
  if (typeof channelId !== "string") throw new Error("Slack returned no code channel ID");
  codeChannels.set(channelId, true);
  return channelId;
}

/**
 * Slack posts the originating message into a new code channel as context. The
 * agent already received it with the request, so it must not start a turn.
 */
export function isOriginContext(message: SlackMessage): boolean {
  const blocks = message.raw.blocks;
  return (
    Array.isArray(blocks) &&
    blocks.some((block) => asRecord(block)?.block_id === "agent_channel_origin_context")
  );
}

/** A message that mentions people but not the agent is talk between teammates. */
export function isAddressedToOthers(text: string, botMentioned: boolean): boolean {
  return !botMentioned && /<@[A-Z0-9]+>/.test(text);
}

/**
 * Sends every turn whose auth names a code channel to that channel's single
 * session, instead of the session of the Slack thread the message came from.
 */
export function withCodeChannelSessions(channel: SlackChannel): SlackChannel {
  const route = (from: ChannelFrom<SlackChannelState>): ChannelFrom<SlackChannelState> => {
    return (address) => {
      const source = from(address);
      return {
        ...source,
        send(message, options) {
          const code = currentCodeChannel(options.auth);
          if (!code) return source.send(message, options);
          return from(slackContinuationToken(code.channelId, CHANNEL_SESSION_THREAD)).send(
            message,
            {
              ...options,
              state: {
                ...options.state,
                channelId: code.channelId,
                threadTs: CHANNEL_SESSION_THREAD,
              },
            },
          );
        },
      };
    };
  };
  return {
    ...channel,
    routes: channel.routes.map((r) =>
      r.transport === "websocket"
        ? r
        : {
            ...r,
            handler: (request, args) => r.handler(request, { ...args, from: route(args.from) }),
          },
    ),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
