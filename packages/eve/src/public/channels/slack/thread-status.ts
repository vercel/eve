import { setSlackCodeChannelStatus } from "#public/channels/slack/code-channel.js";
import {
  SLACK_TYPING_STATUS_MAX_LENGTH,
  truncateTypingStatus,
} from "#public/channels/slack/limits.js";
import type { SlackEventContext } from "#public/channels/slack/slackChannel.js";

const STATUS_REFRESH_MS = 30_000;
const MIN_REASONING_PIECE_LENGTH = 12;

/** The status eve's default renderer last set in the thread. */
export interface SlackThreadStatus {
  readonly atMs: number;
  readonly text: string;
}

export async function showStatus(
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
  channel.state.threadStatus = null;
  await channel.thread.startTyping();
}

const HEADING = /(?:^|\n)[ \t]*\*\*([^*\n]+)\*\*/gu;
const SENTENCE_BOUNDARY = /(?<=[.!?])(?<!(?:^|\s)\d{1,2}\.)\s+(?=[\p{Lu}"'`(])/u;
const LIST_MARKER = /^(?:[-*+]|\d{1,2}[.)])\s+/u;

export function reasoningStatus(
  reasoning: string,
  options?: { readonly complete?: boolean },
): string | undefined {
  const heading = [...reasoning.matchAll(HEADING)].findLast((match) => match[1]!.trim() !== "");
  if (heading) return heading[1]!.trim();

  const pieces = reasoning
    .split(/\r?\n/u)
    .flatMap((line) => line.split(SENTENCE_BOUNDARY))
    .map((piece) => piece.trim().replace(LIST_MARKER, ""));
  const streaming = options?.complete === true ? -1 : pieces.length - 1;
  for (let index = pieces.length - 1; index >= 0; index -= 1) {
    const piece = pieces[index]!;
    const minLength =
      index === streaming ? SLACK_TYPING_STATUS_MAX_LENGTH : MIN_REASONING_PIECE_LENGTH;
    if (piece.length >= minLength && isProse(piece)) return piece;
  }
  return undefined;
}

function isProse(piece: string): boolean {
  return !piece.startsWith("```") && /\p{L}/u.test(piece);
}
