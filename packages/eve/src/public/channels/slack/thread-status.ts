/**
 * The thread status eve's default renderer shows while a turn works. It keeps
 * the last status it set, so a later model step, or a task card post that
 * Slack clears the status for, can show it again instead of a generic line.
 */
import {
  SLACK_TYPING_STATUS_MAX_LENGTH,
  truncateTypingStatus,
} from "#public/channels/slack/limits.js";
import type { SlackEventContext } from "#public/channels/slack/slackChannel.js";

/**
 * Slack drops a status two minutes after it was set. One with the same text
 * set more recently than this is still showing, so it isn't written again.
 */
const STATUS_REFRESH_MS = 30_000;
/** Shorter reasoning sentences, such as `Okay.`, say nothing about the work. */
const MIN_REASONING_PIECE_LENGTH = 12;

/** The status eve's default renderer last set in the thread. */
export interface SlackThreadStatus {
  readonly atMs: number;
  readonly text: string;
}

/**
 * Sets the thread status, unless the same text is already showing. `force`
 * writes it anyway, for moments Slack may have cleared it, and so a long turn
 * keeps it from timing out.
 */
export async function showStatus(
  channel: SlackEventContext,
  text: string,
  options?: { readonly force?: boolean },
): Promise<void> {
  const status = truncateTypingStatus(text);
  const now = Date.now();
  const current = channel.state.threadStatus;
  const showing =
    current?.text === status && now - current.atMs >= 0 && now - current.atMs < STATUS_REFRESH_MS;
  if (showing && options?.force !== true) return;
  await channel.thread.startTyping(status);
  channel.state.threadStatus = { atMs: now, text: status };
}

/** Shows the last status again, if any. */
export async function restoreStatus(channel: SlackEventContext): Promise<void> {
  const current = channel.state.threadStatus;
  if (current) await showStatus(channel, current.text, { force: true });
}

/**
 * Clears the thread status but keeps its text, so the turn shows it again when
 * it resumes. It is no longer showing, so the next write always goes out.
 */
export async function hideStatus(channel: SlackEventContext): Promise<void> {
  const current = channel.state.threadStatus;
  if (current) channel.state.threadStatus = { ...current, atMs: 0 };
  await channel.thread.startTyping();
}

/** Clears the thread status and forgets it: the turn has nothing more to show. */
export async function clearStatus(channel: SlackEventContext): Promise<void> {
  channel.state.threadStatus = null;
  await channel.thread.startTyping();
}

const HEADING = /(?:^|\n)[ \t]*\*\*([^*\n]+)\*\*/gu;
// Same boundary as `firstSentence`: `e.g. the` and `No. 4035` stay whole.
const SENTENCE_BOUNDARY = /(?<=[.!?])(?<!(?:^|\s)\d{1,2}\.)\s+(?=[\p{Lu}"'`(])/u;
const LIST_MARKER = /^(?:[-*+]|\d{1,2}[.)])\s+/u;

/**
 * The newest readable piece of a reasoning block so far: its latest heading
 * when the model titles its reasoning, as reasoning summaries do, otherwise
 * its latest finished sentence. A sentence still streaming counts once it
 * fills the status, so the status never shows half a short sentence. A
 * `complete` block has nothing streaming: its last sentence is finished.
 */
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
