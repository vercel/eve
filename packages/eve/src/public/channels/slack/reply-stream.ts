import { createLogger } from "#internal/logging.js";
import { contentPhase } from "#protocol/session-events/catalog.js";
import type { SlackApiResponse } from "#public/channels/slack/api.js";
import {
  SLACK_MARKDOWN_TEXT_MAX_LENGTH,
  truncateMessageText,
} from "#public/channels/slack/limits.js";
import type { SlackRenderer } from "#public/channels/slack/renderers.js";
import type {
  SlackChannelContext,
  SlackChannelInternalEvents,
  SlackChannelState,
  SlackContext,
  SlackEventContext,
} from "#public/channels/slack/slackChannel.js";
import { threadRootIsGone } from "#public/channels/slack/thread-root.js";

const log = createLogger("slack.stream");

export const SLACK_STREAM_MIN_CHARS = 280;
const APPEND_INTERVAL_MS = 1_000;
const MAX_APPEND_INTERVAL_MS = 30_000;
const STREAM_MAX_AGE_MS = 10 * 60_000;

type StreamStatus = "pending" | "streaming" | "broken" | "stopped" | "off";

interface ReplyStream {
  readonly partId: string;
  readonly runId?: string;
  status: StreamStatus;
  text: string;
  sent: number;
  ts?: string;
  startedAtMs: number;
  lastSentAtMs: number;
  appendIntervalMs: number;
}

const streams = new WeakMap<SlackChannelState, ReplyStream>();

interface StreamDelta {
  readonly partId: string;
  readonly kind?: string;
  readonly delta: string;
}

interface FinalReply {
  readonly markdown: string;
  readonly blocks?: readonly unknown[];
  readonly text?: string;
}

export function renderersAllowStreaming(renderers: readonly SlackRenderer[]): boolean {
  return renderers.every(
    ({ events }) =>
      events?.["content.completed"] === undefined || events["content.delta"] !== undefined,
  );
}

export function withStreamedDeltas(
  render: SlackChannelInternalEvents["content.delta"],
): SlackChannelInternalEvents["content.delta"] {
  return async (event, ctx) => {
    await streamSlackReplyDelta(ctx.channel, event.data, event.scope?.runId);
    await render?.(event, ctx);
  };
}

export function withReplyStreaming(events: SlackChannelInternalEvents): SlackChannelInternalEvents {
  const {
    "content.completed": renderCompleted,
    "model.settled": renderModelSettled,
    "turn.paused": renderPaused,
    "turn.settled": renderSettled,
    "turn.started": renderStarted,
  } = events;
  return {
    ...events,
    async "content.completed"(event, ctx) {
      const { data } = event;
      if (data.kind !== "text") {
        await renderCompleted?.(event, ctx);
        return;
      }
      if (contentPhase(data.phase) === "narration") {
        await discardSlackReplyStream(ctx.channel, { partId: data.partId });
      }
      try {
        await renderCompleted?.(event, ctx);
      } finally {
        await discardSlackReplyStream(ctx.channel, { partId: data.partId });
      }
    },
    async "model.settled"(event, ctx) {
      await discardSlackReplyStream(ctx.channel, { runId: event.data.runId });
      await renderModelSettled?.(event, ctx);
    },
    async "turn.started"(event, ctx) {
      await discardSlackReplyStream(ctx.channel);
      await renderStarted?.(event, ctx);
    },
    async "turn.paused"(event, ctx) {
      await discardSlackReplyStream(ctx.channel);
      await renderPaused?.(event, ctx);
    },
    async "turn.settled"(event, ctx) {
      await discardSlackReplyStream(ctx.channel);
      await renderSettled?.(event, ctx);
    },
  };
}

export function isSlackReplyStreaming(state: SlackChannelState): boolean {
  const status = streams.get(state)?.status;
  return status === "streaming" || status === "broken" || status === "stopped";
}

export async function streamSlackReplyDelta(
  channel: SlackEventContext,
  delta: StreamDelta,
  runId?: string,
): Promise<void> {
  let stream = streams.get(channel.state);
  if (delta.kind !== undefined) {
    if (delta.kind !== "text") return;
    if (stream !== undefined) await discardSlackReplyStream(channel);
    stream = {
      appendIntervalMs: APPEND_INTERVAL_MS,
      lastSentAtMs: 0,
      partId: delta.partId,
      ...(runId !== undefined && { runId }),
      sent: 0,
      startedAtMs: 0,
      status: "pending",
      text: "",
    };
    streams.set(channel.state, stream);
  }
  if (stream === undefined || stream.partId !== delta.partId) return;
  stream.text += delta.delta;
  if (stream.status === "pending") {
    if (stream.text.length >= SLACK_STREAM_MIN_CHARS && channel.state.quietStatus !== true) {
      await startStream(channel, stream);
    }
    return;
  }
  if (stream.status !== "streaming") return;
  if (Date.now() - stream.lastSentAtMs < stream.appendIntervalMs) return;
  await appendStream(channel, stream);
}

export async function finishSlackReplyStream(
  channel: SlackContext,
  reply: FinalReply,
): Promise<boolean> {
  const state = (channel as Partial<SlackChannelContext>).state;
  const stream = state === undefined ? undefined : streams.get(state);
  if (state === undefined || stream === undefined) return false;
  streams.delete(state);
  const { ts } = stream;
  if (ts === undefined) return false;
  if (stream.status === "stopped") return true;
  const target = { channel: channel.slack.channelId, ts };
  const { blocks, markdown, text } = reply;
  const fits = markdown.length <= SLACK_MARKDOWN_TEXT_MAX_LENGTH;
  const extendsStreamed =
    blocks === undefined && markdown.startsWith(stream.text.slice(0, stream.sent));
  const rest =
    stream.status === "streaming" && extendsStreamed && fits ? markdown.slice(stream.sent) : "";
  const stopped = await call(channel, "chat.stopStream", {
    ...target,
    ...(rest.length > 0 && { markdown_text: rest }),
  });
  if (stopped?.ok === true && stream.status === "streaming" && extendsStreamed && fits) return true;
  if (stopped?.ok !== true && stoppedInSlack(stream, stopped)) return true;
  if (blocks !== undefined || fits) {
    const updated = await request(channel, "chat.update", {
      ...target,
      blocks: blocks ?? [{ type: "markdown", text: markdown }],
      text: text ?? truncateMessageText(markdown),
    });
    if (updated) return true;
  }
  await request(channel, "chat.delete", target);
  return false;
}

function stoppedInSlack(stream: ReplyStream, response: SlackApiResponse | undefined): boolean {
  if (response?.error === "stopped_by_user") return true;
  return (
    response?.error === "message_not_in_streaming_state" &&
    Date.now() - stream.startedAtMs < STREAM_MAX_AGE_MS
  );
}

export async function discardSlackReplyStream(
  channel: SlackEventContext,
  of: { readonly partId?: string; readonly runId?: string } = {},
): Promise<void> {
  const stream = streams.get(channel.state);
  if (stream === undefined) return;
  if (of.partId !== undefined && stream.partId !== of.partId) return;
  if (of.runId !== undefined && stream.runId !== of.runId) return;
  streams.delete(channel.state);
  if (stream.ts === undefined) return;
  const target = { channel: channel.slack.channelId, ts: stream.ts };
  if (stream.status === "streaming" || stream.status === "broken") {
    await request(channel, "chat.stopStream", target);
  }
  await request(channel, "chat.delete", target);
}

function streamTarget(channel: SlackEventContext): Record<string, string> | undefined {
  const { channelId, codeChannel, threadTs } = channel.slack;
  if (!channelId) return undefined;
  const thread = codeChannel ? (channel.state.replyThreadTs ?? "") : threadTs;
  if (!codeChannel && !thread) return undefined;
  const recipient = channel.state.triggeringUserId;
  const team = channel.state.teamId;
  const directMessage = channelId.startsWith("D");
  if (!directMessage && (!recipient || !team)) return undefined;
  return {
    channel: channelId,
    ...(thread && { thread_ts: thread }),
    ...(!directMessage && recipient && team
      ? { recipient_team_id: team, recipient_user_id: recipient }
      : {}),
  };
}

async function startStream(channel: SlackEventContext, stream: ReplyStream): Promise<void> {
  const target = streamTarget(channel);
  if (
    target === undefined ||
    stream.text.length > SLACK_MARKDOWN_TEXT_MAX_LENGTH ||
    (await threadRootIsGone(channel))
  ) {
    stream.status = "off";
    return;
  }
  const response = await call(channel, "chat.startStream", {
    ...target,
    markdown_text: stream.text,
  });
  if (response?.ok !== true || typeof response.ts !== "string" || response.ts === "") {
    stream.status = "off";
    return;
  }
  stream.ts = response.ts;
  stream.sent = stream.text.length;
  stream.startedAtMs = Date.now();
  stream.lastSentAtMs = stream.startedAtMs;
  stream.status = "streaming";
  channel.state.postedInThread = true;
  channel.state.threadStatus = null;
}

async function appendStream(channel: SlackEventContext, stream: ReplyStream): Promise<void> {
  const piece = stream.text.slice(stream.sent);
  if (piece.length === 0 || stream.ts === undefined) return;
  if (stream.text.length > SLACK_MARKDOWN_TEXT_MAX_LENGTH) {
    stream.status = "broken";
    return;
  }
  const response = await call(channel, "chat.appendStream", {
    channel: channel.slack.channelId,
    markdown_text: piece,
    ts: stream.ts,
  });
  if (response?.error === "ratelimited") {
    stream.appendIntervalMs = Math.min(stream.appendIntervalMs * 2, MAX_APPEND_INTERVAL_MS);
    stream.lastSentAtMs = Date.now();
    return;
  }
  if (response?.ok !== true) {
    stream.status = response?.error === "stopped_by_user" ? "stopped" : "broken";
    return;
  }
  stream.sent = stream.text.length;
  stream.lastSentAtMs = Date.now();
}

async function call(
  channel: SlackContext,
  operation: string,
  body: Record<string, unknown>,
): Promise<SlackApiResponse | undefined> {
  let response: SlackApiResponse;
  try {
    response = await channel.slack.request(operation, body);
  } catch (error) {
    if ((error as { readonly status?: unknown } | null)?.status !== 429) {
      log.warn("Slack reply stream call failed", { error, operation });
      return undefined;
    }
    response = { error: "ratelimited", ok: false };
  }
  if (response.ok !== true) {
    log.warn("Slack refused a reply stream call", {
      operation,
      slackError: response.error ?? "unknown_error",
    });
  }
  return response;
}

async function request(
  channel: SlackContext,
  operation: string,
  body: Record<string, unknown>,
): Promise<boolean> {
  return (await call(channel, operation, body))?.ok === true;
}
