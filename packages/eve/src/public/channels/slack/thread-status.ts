import { setSlackCodeChannelStatus } from "#public/channels/slack/code-channel.js";
import { truncateTypingStatus } from "#public/channels/slack/limits.js";
import type { SlackChannelState, SlackEventContext } from "#public/channels/slack/slackChannel.js";
import type { ChannelEventContext } from "#public/definitions/channel.js";

const STATUS_REFRESH_MS = 30_000;

/** The status eve's default renderer last set in the thread. */
export interface SlackThreadStatus {
  readonly atMs: number;
  readonly text: string;
}

const statusWrites = new WeakMap<SlackChannelState, Promise<void>>();

export async function statusWritesSettled(channel: SlackEventContext): Promise<void> {
  await statusWrites.get(channel.state);
}

export function showStatusBehindTurn(
  ctx: ChannelEventContext<SlackEventContext>,
  next: () => { readonly text: string; readonly force?: boolean },
): void {
  const { channel } = ctx;
  const written = (statusWrites.get(channel.state) ?? Promise.resolve()).then(() => {
    const { text, ...options } = next();
    return writeStatus(channel, text, options);
  });
  statusWrites.set(
    channel.state,
    written.catch(() => {}),
  );
  ctx.waitUntil(written);
}

export async function showStatus(
  channel: SlackEventContext,
  text: string,
  options?: { readonly force?: boolean },
): Promise<void> {
  await statusWritesSettled(channel);
  await writeStatus(channel, text, options);
}

async function writeStatus(
  channel: SlackEventContext,
  text: string,
  options?: { readonly force?: boolean },
): Promise<void> {
  if (channel.state.quietStatus === true) return;
  const status = truncateTypingStatus(text);
  const now = Date.now();
  const current = channel.state.threadStatus;
  if (isCodeChannel(channel) && current != null && current.atMs > 0) {
    channel.state.threadStatus = { atMs: now, text: status };
    return;
  }
  const showing =
    current?.text === status && now - current.atMs >= 0 && now - current.atMs < STATUS_REFRESH_MS;
  if (showing && options?.force !== true) return;
  await channel.thread.startTyping(status);
  channel.state.threadStatus = { atMs: now, text: status };
}

export async function restoreStatus(channel: SlackEventContext): Promise<void> {
  const current = channel.state.threadStatus;
  if (current) await showStatus(channel, current.text, { force: true });
}

export async function hideStatus(channel: SlackEventContext): Promise<void> {
  await statusWritesSettled(channel);
  const current = channel.state.threadStatus;
  if (current) channel.state.threadStatus = { ...current, atMs: 0 };
  if (isCodeChannel(channel)) {
    await setSlackCodeChannelStatus(channel.slack.request, channel.slack.channelId, "suspended");
    return;
  }
  await channel.thread.startTyping();
}

function isCodeChannel(channel: SlackEventContext): boolean {
  return channel.slack.codeChannel;
}

export async function clearStatus(channel: SlackEventContext): Promise<void> {
  await statusWritesSettled(channel);
  channel.state.threadStatus = null;
  await channel.thread.startTyping();
}
