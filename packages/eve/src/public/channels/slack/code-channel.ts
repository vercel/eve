/**
 * Slack code channels: a dedicated channel per agent task, served as one eve
 * session. See https://docs.slack.dev/ai/slack-code.
 */
import { createHash } from "node:crypto";

import { createLogger, logError } from "#internal/logging.js";
import type { SlackApiResponse } from "#public/channels/slack/api.js";

const log = createLogger("slack.code-channel");

export type SlackRequest = (operation: string, body: unknown) => Promise<SlackApiResponse>;

const MAX_CACHED_CHANNELS = 1_000;
/** A failed lookup is retried after this, so a broken install doesn't call Slack per message. */
const FAILED_LOOKUP_TTL_MS = 60_000;
// Slack sets a channel's kind at creation, so a lookup holds for the process.
const codeChannelCache = new Map<string, boolean | { readonly failedAtMs: number }>();

/**
 * Whether the conversation is a code channel. A failed lookup counts as not a
 * code channel, so its messages get per-thread sessions until a retry
 * succeeds a minute later.
 */
export async function isSlackCodeChannel(
  channelId: string,
  request: SlackRequest,
): Promise<boolean> {
  const cached = codeChannelCache.get(channelId);
  if (typeof cached === "boolean") return cached;
  if (cached !== undefined && Date.now() - cached.failedAtMs < FAILED_LOOKUP_TTL_MS) return false;
  let codeChannel: boolean;
  try {
    const response = await request("conversations.info", { channel: channelId });
    if (response.ok !== true) {
      log.error(
        response.error === "missing_scope"
          ? "conversations.info needs the channels:read and groups:read scopes to detect code channels; reinstall the Slack app"
          : "conversations.info failed; treating the channel as an ordinary channel",
        { channelId, error: response.error },
      );
      cacheLookup(channelId, { failedAtMs: Date.now() });
      return false;
    }
    const channel = response.channel as
      | { readonly properties?: { readonly record_channel?: { readonly record_type?: unknown } } }
      | undefined;
    codeChannel = channel?.properties?.record_channel?.record_type === "agent_channel";
  } catch (error) {
    logError(log, "conversations.info threw; treating the channel as an ordinary channel", error, {
      channelId,
    });
    cacheLookup(channelId, { failedAtMs: Date.now() });
    return false;
  }
  cacheLookup(channelId, codeChannel);
  return codeChannel;
}

function cacheLookup(channelId: string, value: boolean | { readonly failedAtMs: number }): void {
  codeChannelCache.delete(channelId);
  if (codeChannelCache.size >= MAX_CACHED_CHANNELS) {
    codeChannelCache.delete(codeChannelCache.keys().next().value!);
  }
  codeChannelCache.set(channelId, value);
}

// Slack errors worth retrying; any other refusal won't change on retry.
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

/** Slack shows the name as the channel's title; longer ones are cut. */
const MAX_CODE_CHANNEL_NAME_LENGTH = 80;

/**
 * Opens a code channel from an origin message. Slack invites the origin
 * message's author, links the channel in the origin thread, and refuses Slack
 * Connect origins. `session_id` makes the call idempotent, so a retry with the
 * same origin and requester returns the same channel. Throws an error marked
 * `fatal` when Slack refuses permanently, so the calling step doesn't retry.
 *
 * eve reads the origin before creating anything and asks for a private
 * channel when the origin is private. Slack always honors an explicit
 * `is_private`, so the check after creation is a backstop: on a mismatch eve
 * archives the channel and throws.
 */
export async function createSlackCodeChannel(input: {
  readonly name: string;
  readonly originChannelId: string;
  readonly originTs: string;
  /** Principal the channel is opened for; one channel per requester and origin message. */
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
    // Without a name, Slack names the channel from the origin message.
    ...(name.length > 0 && { name }),
    // Omitted for a public origin, so Slack keeps its default of letting origin members join.
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
  cacheLookup(channelId, true);
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

// The Workflow SDK doesn't retry a step error marked `fatal`; channels stay free of its imports.
function fatalError(message: string): Error {
  return Object.assign(new Error(message), { fatal: true });
}

/**
 * Whether a message is the origin quote Slack posts when it creates a code
 * channel from a message. It is context, not a request.
 */
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

/** Slack agent session lifecycle states. */
export type SlackSessionStatus = "active" | "processing" | "suspended";

/** Sets a code channel's session status. Failures are logged, never thrown. */
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

/** Slack's `thread_ts` for a session thread: omitted for top-level posts. */
export function slackThreadTsParam(threadTs: string): string | undefined {
  return threadTs === "" ? undefined : threadTs;
}
