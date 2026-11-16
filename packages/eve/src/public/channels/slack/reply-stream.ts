/**
 * Streams a reply into Slack as the model writes it, with Slack's native
 * `chat.startStream`, `chat.appendStream`, and `chat.stopStream`.
 *
 * Whether a text part is the reply or narration before a tool call is only
 * known when it completes, so a part streams only once it outgrows what
 * narration usually is. What streams is the text that reaches eve's default
 * `content.delta`, so renderers decide it as they do the rest. The finished
 * reply still goes through the renderer chain: delivering it finalizes the
 * streamed message instead of posting a new one, and rewrites it when a
 * renderer changed the text. A part that turns out to be narration, that the
 * chain never delivers, or that its model run never completes is removed.
 *
 * A stream lives within the model step that writes its part, so it's kept in
 * memory per state object, like the default renderer's step stream, and never
 * serialized.
 */
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

/**
 * Narration before tool calls rarely runs this long, so longer text is the
 * reply being written. Shorter replies post whole, which Slack recommends for
 * fast responses anyway.
 */
export const SLACK_STREAM_MIN_CHARS = 280;
/** `chat.appendStream` is Tier 4 (100+ per minute), so appends wait at least this long. */
const APPEND_INTERVAL_MS = 1_000;
/**
 * Slack counts appends per app and workspace, so other replies streaming at
 * once share them. Each rate-limited append doubles the wait, up to this.
 */
const MAX_APPEND_INTERVAL_MS = 30_000;
/** Slack finalizes a stream this long after it starts. */
const STREAM_MAX_AGE_MS = 10 * 60_000;

type StreamStatus =
  /** Collecting text until it passes {@link SLACK_STREAM_MIN_CHARS}. */
  | "pending"
  /** Slack is showing the part as it streams. */
  | "streaming"
  /** The message exists but stopped taking text: an error, the 10-minute limit, or 12,000 characters. */
  | "broken"
  /** Someone pressed stop in Slack, which finalized the message as it was. */
  | "stopped"
  /** This part never streams: no target, or Slack refused to start it. */
  | "off";

interface ReplyStream {
  readonly partId: string;
  /** The model run writing the part. */
  readonly runId?: string;
  status: StreamStatus;
  /** Everything the part has written so far. */
  text: string;
  /** How much of `text` Slack accepted. */
  sent: number;
  ts?: string;
  startedAtMs: number;
  lastSentAtMs: number;
  appendIntervalMs: number;
}

const streams = new WeakMap<SlackChannelState, ReplyStream>();

/** The fields of a delta the stream reads. */
interface StreamDelta {
  readonly partId: string;
  readonly kind?: string;
  readonly delta: string;
}

/** The completed reply {@link finishSlackReplyStream} finalizes the stream with. */
interface FinalReply {
  readonly markdown: string;
  readonly blocks?: readonly unknown[];
  readonly text?: string;
}

/**
 * Whether `renderers` let replies stream. The stream carries the text that
 * reaches eve's default `content.delta`, so a renderer that changes replies at
 * `content.completed`, such as one that redacts them, must also handle
 * `content.delta` to decide what streams: pass a delta on, change it, or drop
 * it. Until it does, replies post whole, so streaming never shows text the
 * renderer would have changed.
 */
export function renderersAllowStreaming(renderers: readonly SlackRenderer[]): boolean {
  return renderers.every(
    ({ events }) =>
      events?.["content.completed"] === undefined || events["content.delta"] !== undefined,
  );
}

/**
 * Wraps eve's default `content.delta`, the innermost link of the renderer
 * chain, so the text deltas that reach it feed the stream.
 */
export function withStreamedDeltas(
  render: SlackChannelInternalEvents["content.delta"],
): SlackChannelInternalEvents["content.delta"] {
  return async (event, ctx) => {
    await streamSlackReplyDelta(ctx.channel, event.data, event.scope?.runId);
    await render?.(event, ctx);
  };
}

/**
 * Wraps a Slack channel's composed events, renderers included, so streamed
 * parts end: a text part's completion removes its streamed message once the
 * chain is done with it, unless delivering it finalized the message; a model
 * run that settles removes a part it never completed; and a turn that starts,
 * pauses, or settles drops any stream left open.
 */
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
      // eve doesn't post narration; it shows in the status instead.
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
      // A part its run never completed, such as text a content filter cut off or a failed
      // attempt's, is no reply. The retry, if any, writes its own.
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

/** Whether a reply is streaming, so the default renderer doesn't also say one is being written. */
export function isSlackReplyStreaming(state: SlackChannelState): boolean {
  const status = streams.get(state)?.status;
  return status === "streaming" || status === "broken" || status === "stopped";
}

/** Feeds one `content.delta` to the reply stream. Never throws: streaming is best effort. */
export async function streamSlackReplyDelta(
  channel: SlackEventContext,
  delta: StreamDelta,
  runId?: string,
): Promise<void> {
  let stream = streams.get(channel.state);
  // A part announces its kind with its first delta.
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
    // A quiet turn shows nothing until it does some work, so its text waits too.
    if (stream.text.length >= SLACK_STREAM_MIN_CHARS && channel.state.quietStatus !== true) {
      await startStream(channel, stream);
    }
    return;
  }
  if (stream.status !== "streaming") return;
  if (Date.now() - stream.lastSentAtMs < stream.appendIntervalMs) return;
  await appendStream(channel, stream);
}

/**
 * Finalizes the streamed message as the completed reply: closes the stream
 * with the text still unsent, or, when the reply is not what streamed (a
 * renderer changed it or added blocks), rewrites the message with
 * `chat.update`. Returns whether the reply is now showing; when it isn't,
 * the streamed message is gone and the caller posts the reply as usual.
 */
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
  // Someone stopped the reply in Slack; posting it again would undo that.
  if (stream.status === "stopped") return true;
  const target = { channel: channel.slack.channelId, ts };
  const { blocks, markdown, text } = reply;
  const fits = markdown.length <= SLACK_MARKDOWN_TEXT_MAX_LENGTH;
  const extendsStreamed =
    blocks === undefined && markdown.startsWith(stream.text.slice(0, stream.sent));
  const rest =
    stream.status === "streaming" && extendsStreamed && fits ? markdown.slice(stream.sent) : "";
  // Ends a stream Slack still holds open, with the rest of the reply when it only extends what
  // streamed, so an update below lands on a finished message.
  const stopped = await call(channel, "chat.stopStream", {
    ...target,
    ...(rest.length > 0 && { markdown_text: rest }),
  });
  if (stopped?.ok === true && stream.status === "streaming" && extendsStreamed && fits) return true;
  // Someone may have pressed stop after the last append.
  if (stopped?.ok !== true && stoppedInSlack(stream, stopped)) return true;
  if (blocks !== undefined || fits) {
    const updated = await request(channel, "chat.update", {
      ...target,
      blocks: blocks ?? [{ type: "markdown", text: markdown }],
      text: text ?? truncateMessageText(markdown),
    });
    if (updated) return true;
  }
  // When even this fails, the caller still posts the reply: a partial copy left above it beats
  // a lost reply, and a message someone already deleted can't be removed anyway.
  await request(channel, "chat.delete", target);
  return false;
}

/**
 * Whether Slack refused to stop the stream because someone pressed stop. Slack
 * documents `stopped_by_user` only for appends; a stream it has already
 * finalized answers `message_not_in_streaming_state`, which before the
 * 10-minute limit only stop explains.
 */
function stoppedInSlack(stream: ReplyStream, response: SlackApiResponse | undefined): boolean {
  if (response?.error === "stopped_by_user") return true;
  return (
    response?.error === "message_not_in_streaming_state" &&
    Date.now() - stream.startedAtMs < STREAM_MAX_AGE_MS
  );
}

/**
 * Removes the streamed message of a part, of a model run, or of any part: it
 * turned out to be narration, the renderer chain never delivered it, its run
 * ended without completing it, or the turn ended.
 */
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

/**
 * Where the stream goes. Slack streams only into a thread, except top-level in
 * a code channel, and outside a DM it needs the person the reply is for.
 */
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
  // Slack clears the status when the app posts.
  channel.state.threadStatus = null;
}

async function appendStream(channel: SlackEventContext, stream: ReplyStream): Promise<void> {
  const piece = stream.text.slice(stream.sent);
  if (piece.length === 0 || stream.ts === undefined) return;
  // Slack's limit covers the whole stream; the finished reply takes eve's usual fallbacks.
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
    // The stream keeps going: the next delta after the longer wait sends everything unsent.
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

/**
 * Calls Slack and logs a failure by its code, never the text. Slack answers a
 * rate-limited call with HTTP 429, which the transport throws; it comes back
 * as Slack's `ratelimited` error.
 */
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
