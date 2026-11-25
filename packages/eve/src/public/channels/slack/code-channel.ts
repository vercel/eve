import { createHash } from "node:crypto";

import { createLogger, logError } from "#internal/logging.js";
import type { SlackApiResponse } from "#public/channels/slack/api.js";
import { createSlackLookupCache } from "#public/channels/slack/lookup-cache.js";

const log = createLogger("slack.code-channel");

export type SlackRequest = (operation: string, body: unknown) => Promise<SlackApiResponse>;

const FAILED_LOOKUP_TTL_MS = 60_000;
const codeChannelCache = createSlackLookupCache<boolean>({
  failedTtlMs: FAILED_LOOKUP_TTL_MS,
  ttlMs: Number.POSITIVE_INFINITY,
});

export function isSlackCodeChannel(channelId: string, request: SlackRequest): Promise<boolean> {
  return codeChannelCache.getOrLoad(channelId, async () => {
    try {
      const response = await request("conversations.info", { channel: channelId });
      if (response.ok !== true) {
        log.error(
          response.error === "missing_scope"
            ? "conversations.info needs the channels:read and groups:read scopes to detect code channels; reinstall the Slack app"
            : "conversations.info failed; treating the channel as an ordinary channel",
          { channelId, error: response.error },
        );
        return { failed: true, value: false };
      }
      const channel = response.channel as
        | { readonly properties?: { readonly record_channel?: { readonly record_type?: unknown } } }
        | undefined;
      return { value: channel?.properties?.record_channel?.record_type === "agent_channel" };
    } catch (error) {
      logError(
        log,
        "conversations.info threw; treating the channel as an ordinary channel",
        error,
        {
          channelId,
        },
      );
      return { failed: true, value: false };
    }
  });
}

const TRANSIENT_SLACK_ERRORS: ReadonlySet<string> = new Set([
  "channel_creation_failed",
  "fatal_error",
  "internal_error",
  "invite_failed",
  "open_failed",
  "ratelimited",
  "request_timeout",
  "service_unavailable",
]);

const MAX_CODE_CHANNEL_NAME_LENGTH = 80;

export async function createSlackCodeChannel(input: {
  readonly name: string;
  readonly originChannelId: string;
  readonly originTs: string;
  readonly requester: string;
  readonly request: SlackRequest;
}): Promise<{ readonly channelId: string; readonly isPrivate: boolean }> {
  const sessionId = createHash("sha256")
    .update(`${input.originChannelId}:${input.originTs}:${input.requester}`)
    .digest("hex")
    .slice(0, 32);
  const name = input.name.replace(/\s+/gu, " ").trim().slice(0, MAX_CODE_CHANNEL_NAME_LENGTH);
  const originIsPrivate = isPrivateConversation(
    await readConversation(input.request, input.originChannelId),
  );
  const response = await input.request("agents.conversations.create", {
    ...(name.length > 0 && { name }),
    ...(originIsPrivate && { is_private: true }),
    origin_channel_id: input.originChannelId,
    origin_message_ts: input.originTs,
    session_id: sessionId,
  });
  if (response.ok !== true) throw slackFailure("agents.conversations.create", response.error);
  const channelId = response.channel_id;
  if (typeof channelId !== "string" || channelId.length === 0) {
    throw new Error("Slack did not return a channel id for the new code channel.");
  }
  codeChannelCache.set(channelId, true);
  if (originIsPrivate && !isPrivateConversation(await readConversation(input.request, channelId))) {
    const archived = await input.request("agents.conversations.archive", { channel_id: channelId });
    throw fatalError(
      `Slack opened code channel ${channelId} as public from a private conversation, so eve ${archived.ok === true ? "archived it" : "couldn't archive it"} and didn't copy the conversation into it.`,
    );
  }
  return { channelId, isPrivate: originIsPrivate };
}

async function readConversation(
  request: SlackRequest,
  channelId: string,
): Promise<Record<string, unknown>> {
  const response = await request("conversations.info", { channel: channelId });
  if (response.ok !== true) throw slackFailure("conversations.info", response.error);
  return (response.channel ?? {}) as Record<string, unknown>;
}

function isPrivateConversation(conversation: Record<string, unknown>): boolean {
  return (
    conversation.is_private === true || conversation.is_im === true || conversation.is_mpim === true
  );
}

function slackFailure(method: string, error: unknown): Error {
  const code = typeof error === "string" ? error : "unknown_error";
  const message = `Slack ${method} failed: ${code}`;
  return TRANSIENT_SLACK_ERRORS.has(code) ? new Error(message) : fatalError(message);
}

function fatalError(message: string): Error {
  return Object.assign(new Error(message), { fatal: true });
}

export function isSlackCodeChannelOriginContext(raw: Record<string, unknown>): boolean {
  const blocks = raw.blocks;
  return (
    Array.isArray(blocks) &&
    blocks.some(
      (block) =>
        (block as { readonly block_id?: unknown } | null)?.block_id ===
        "agent_channel_origin_context",
    )
  );
}

export type SlackSessionStatus = "active" | "processing" | "suspended";

export async function setSlackCodeChannelStatus(
  request: SlackRequest,
  channelId: string,
  status: SlackSessionStatus,
): Promise<void> {
  try {
    const response = await request("agents.sessions.setStatus", { channel_id: channelId, status });
    if (response.ok !== true) {
      log.warn("agents.sessions.setStatus returned not-ok", { error: response.error, status });
    }
  } catch (error) {
    logError(log, "agents.sessions.setStatus threw", error, { channelId });
  }
}

export function slackThreadTsParam(threadTs: string): string | undefined {
  return threadTs === "" ? undefined : threadTs;
}
