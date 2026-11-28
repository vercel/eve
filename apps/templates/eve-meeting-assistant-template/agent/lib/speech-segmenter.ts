import { isChatOnly, readReplyMode, replyModeOf, type ReplyMode } from "./reply-mode.js";

/** A long sentence is spoken in pieces so the first words don't wait on the rest. */
const MAX_SEGMENT_CHARS = 240;

/** One piece of speech: the turn and message it belongs to, and the words to say. */
export interface SpeechSegment {
  readonly turnId: string | undefined;
  readonly partId: string;
  readonly text: string;
}

/**
 * Cuts the agent's streamed text into sentences as they finish, so the first
 * one is spoken while the model is still writing the rest. A message tagged
 * `[chat]` is never spoken, and neither is an untagged one in a turn that only
 * the chat started.
 */
export class SpeechSegmenter {
  /**
   * Only a part's first delta names its kind and turn. `text` is unknown for
   * a part whose first delta this reader missed, such as after a reconnect.
   * `mode` is unknown until the start of the message rules a tag in or out.
   */
  private readonly parts = new Map<
    string,
    {
      buffer: string;
      text: boolean | undefined;
      turnId: string | undefined;
      mode: ReplyMode | undefined;
    }
  >();
  /** Whether each turn this reader saw start was started only by the chat. */
  private readonly chatOnlyTurns = new Map<string, boolean>();
  private readonly say: (segment: SpeechSegment) => void;
  private readonly resumed: boolean;

  /**
   * `resumed` is set when this reader picks up where an earlier one left off.
   * A message whose start it missed was then already partly spoken, so it
   * isn't spoken again from its final text.
   */
  constructor(say: (segment: SpeechSegment) => void, options: { readonly resumed?: boolean } = {}) {
    this.say = say;
    this.resumed = options.resumed ?? false;
  }

  heard(turnId: string, lines: readonly string[]): void {
    const chatOnly = isChatOnly(lines);
    if (chatOnly === undefined) return;
    // A turn that hears several deliveries is spoken if any of them was.
    this.chatOnlyTurns.set(turnId, (this.chatOnlyTurns.get(turnId) ?? true) && chatOnly);
  }

  /**
   * Where an untagged message goes: nowhere aloud for a chat request, and
   * aloud otherwise, including for a turn this reader didn't see start.
   */
  private untagged(turnId: string | undefined): ReplyMode {
    return turnId !== undefined && this.chatOnlyTurns.get(turnId) === true ? "chat" : "voice";
  }

  delta(
    turnId: string | undefined,
    data: { readonly partId: string; readonly kind?: string; readonly delta: string },
  ): void {
    let part = this.parts.get(data.partId);
    if (part === undefined) {
      const text = data.kind === undefined ? undefined : data.kind === "text";
      part = { buffer: "", mode: undefined, text, turnId };
      this.parts.set(data.partId, part);
    }
    if (part.text !== true || part.mode === "chat") return;
    part.buffer += data.delta;
    if (part.mode === undefined) {
      const read = readReplyMode(part.buffer);
      if (read === undefined) return;
      part.mode = read.mode ?? this.untagged(part.turnId);
      part.buffer = read.text;
      if (part.mode === "chat") return;
    }
    for (;;) {
      const cut = sentenceEnd(part.buffer);
      if (cut === -1) break;
      this.emit(part.turnId, data.partId, part.buffer.slice(0, cut));
      part.buffer = part.buffer.slice(cut);
    }
  }

  complete(turnId: string | undefined, partId: string, value: string): void {
    const part = this.parts.get(partId);
    this.parts.delete(partId);
    if (part?.text === true && part.mode !== undefined) {
      if (part.mode !== "chat") this.emit(part.turnId ?? turnId, partId, part.buffer);
      return;
    }
    // Followed from its start but too short to have ruled out a tag.
    const followed = part?.text === true;
    if (!followed && this.resumed) return;
    // A part this reader didn't follow from its start is read from its final value.
    const owner = part?.turnId ?? turnId;
    const { mode, text } = replyModeOf(value);
    if ((mode ?? this.untagged(owner)) !== "chat") this.emit(owner, partId, text);
  }

  private emit(turnId: string | undefined, partId: string, text: string): void {
    const spoken = toSpeech(text);
    if (spoken) this.say({ partId, text: spoken, turnId });
  }
}

/** Where the first complete sentence in `text` ends, or -1. */
export function sentenceEnd(text: string): number {
  const match = /[.!?…](?=\s)|\n/u.exec(text);
  if (match !== null) return match.index + match[0].length;
  if (text.length < MAX_SEGMENT_CHARS) return -1;
  const pause = Math.max(
    text.lastIndexOf(", ", MAX_SEGMENT_CHARS),
    text.lastIndexOf(" ", MAX_SEGMENT_CHARS),
  );
  return pause > 0 ? pause + 1 : MAX_SEGMENT_CHARS;
}

/** Drops what reads badly aloud: links, which go to the chat instead, and Markdown. */
export function toSpeech(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/https?:\/\/\S+/gu, "")
    .replace(/[*_`#>]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}
