import { randomUUID } from "node:crypto";

import {
  callRecallApi,
  recallBotConfig,
  resolveRecallWebhookUrl,
  type RecallChannelState,
} from "@eve/recall";
import { gateway, generateSpeech } from "ai";
import { GET, type RouteDefinition, type RouteHandlerArgs } from "eve/channels";

import { isChatLine, readReplyMode, replyModeOf, type ReplyMode } from "./reply-mode";
import { VOICE_PAGE_HTML } from "./voice-page";

/** Bot metadata key holding the secret in the bot's voice page URL. */
const VOICE_KEY = "eve_voice_key";
const SPEECH_MODEL = process.env.VOICE_SPEECH_MODEL ?? "openai/tts-1";
const SPEECH_VOICE = process.env.VOICE_SPEECH_VOICE ?? "alloy";
/** A long sentence is spoken in pieces so the first words don't wait on the rest. */
const MAX_SEGMENT_CHARS = 240;

/**
 * The `POST /bot/` body for a bot that speaks: the channel's config plus an
 * Output Media page at `<webhook route>/voice`. The page URL carries a random
 * key, stored in the bot's metadata, that the page trades for the bot's
 * session. The webhook URL's query, such as a protection bypass, carries over.
 */
export function voiceBotConfig(input: {
  readonly meetingUrl: string;
  readonly greeting?: string;
}): Record<string, unknown> {
  const key = randomUUID();
  const webhookUrl = resolveRecallWebhookUrl();
  const pageUrl = new URL(webhookUrl);
  pageUrl.pathname = `${pageUrl.pathname.replace(/\/+$/u, "")}/voice`;
  pageUrl.searchParams.set("key", key);
  return {
    ...recallBotConfig({
      ...input,
      metadata: { [VOICE_KEY]: key },
      outputMediaUrl: pageUrl.toString(),
      webhookUrl,
    }),
    // Recall's default bot is too slow to decode and play audio smoothly.
    variant: { google_meet: "web_4_core", microsoft_teams: "web_4_core", zoom: "web_4_core" },
  };
}

/** The voice page and the stream of speech it plays, mounted on the Recall channel. */
export function voiceRoutes(route = "/eve/v1/recall"): RouteDefinition<RecallChannelState>[] {
  return [
    GET<RecallChannelState>(
      `${route}/voice`,
      async () =>
        new Response(VOICE_PAGE_HTML, {
          headers: { "cache-control": "no-store", "content-type": "text/html; charset=utf-8" },
        }),
    ),
    GET<RecallChannelState>(`${route}/voice/stream`, streamSpeech),
  ];
}

/**
 * Follows the meeting's session and answers with NDJSON: each sentence the
 * agent writes, synthesized as MP3, in order. `cursor` resumes after the last
 * line the page saw; a first connect starts at the session's tail.
 */
async function streamSpeech(
  request: Request,
  { resolveSession }: RouteHandlerArgs<RecallChannelState>,
): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const key = query.get("key") ?? "";
  if (!/^[0-9a-f-]{36}$/u.test(key)) return new Response("not found", { status: 404 });
  const botId = await botIdForKey(key);
  if (botId === undefined) return new Response("not found", { status: 404 });
  // The session starts with the bot's first meeting event; the page retries until then.
  const session = await resolveSession(botId);
  if (session === undefined) return new Response("not ready", { status: 425 });

  const cursor = Number(query.get("cursor") ?? Number.NaN);
  const resuming = Number.isInteger(cursor) && cursor >= 0;
  const encoder = new TextEncoder();
  const events = session.stream({
    signal: request.signal,
    startIndex: resuming ? cursor : -1,
  });

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Speech is generated in parallel but written in order.
      let chain: Promise<void> = Promise.resolve();
      const write = (message: Promise<object | undefined>) => {
        chain = chain.then(async () => {
          const value = await message.catch((error: unknown) => {
            console.error("voice: speech failed", error);
            return undefined;
          });
          if (value === undefined || request.signal.aborted) return;
          controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
        });
      };
      const segmenter = new SpeechSegmenter((turnId, text) =>
        write(speak(text).then((audio) => ({ audio, text, turnId, type: "say" }))),
      );

      // Starting at the tail rereads its last line, which was already played.
      let skipLine: number | undefined;
      try {
        for await (const event of events) {
          const { line } = event.meta.position;
          if (!resuming) skipLine ??= line;
          if (line === skipLine) continue;

          if (event.type === "delivery.consumed") {
            const lines = event.data.parts.flatMap((part) =>
              part.kind === "text" ? [part.text] : [],
            );
            segmenter.heard(event.data.turnId, lines);
          } else if (event.type === "content.delta") {
            segmenter.delta(event.scope?.turnId, event.data);
          } else if (event.type === "content.completed" && event.data.kind === "text") {
            const { partId, value } = event.data;
            if (typeof value === "string") segmenter.complete(event.scope?.turnId, partId, value);
          }
          if (event.meta.endOfLine !== false) {
            const next = event.meta.next ?? line + 1;
            write(Promise.resolve({ cursor: next, type: "cursor" }));
          }
        }
      } catch (error) {
        if (!request.signal.aborted) console.error("voice: session stream failed", error);
      }
      await chain;
      controller.close();
    },
  });
  return new Response(body, {
    headers: { "cache-control": "no-store", "content-type": "application/x-ndjson" },
  });
}

/** The bot whose metadata holds `key`, so a page URL only ever reads its own meeting. */
async function botIdForKey(key: string): Promise<string | undefined> {
  const page = await callRecallApi<{ results?: { id: string }[] }>({
    path: `/bot/?metadata__${VOICE_KEY}=${encodeURIComponent(key)}`,
  });
  const bots = page.results ?? [];
  return bots.length === 1 ? bots[0]!.id : undefined;
}

async function speak(text: string): Promise<string> {
  const { audio } = await generateSpeech({
    abortSignal: AbortSignal.timeout(15_000),
    model: gateway.speech(SPEECH_MODEL),
    outputFormat: "mp3",
    text,
    voice: SPEECH_VOICE,
  });
  return audio.base64;
}

/**
 * Cuts the agent's streamed text into sentences as they finish, so the first
 * one is spoken while the model is still writing the rest. Narration before a
 * tool call, such as "On it, let me check.", is spoken too. A message tagged
 * `[chat]` is never spoken.
 */
class SpeechSegmenter {
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
  /** Turns that someone started by speaking, rather than only in the chat. */
  private readonly spokenTurns = new Set<string>();
  private readonly say: (turnId: string, text: string) => void;

  constructor(say: (turnId: string, text: string) => void) {
    this.say = say;
  }

  heard(turnId: string, lines: readonly string[]): void {
    if (lines.some((line) => !isChatLine(line))) this.spokenTurns.add(turnId);
  }

  /** Where an untagged message goes: aloud for a spoken request, nowhere for a chat one. */
  private untagged(turnId: string | undefined): ReplyMode {
    return turnId !== undefined && !this.spokenTurns.has(turnId) ? "chat" : "voice";
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
      this.emit(part.turnId, part.buffer.slice(0, cut));
      part.buffer = part.buffer.slice(cut);
    }
  }

  complete(turnId: string | undefined, partId: string, value: string): void {
    const part = this.parts.get(partId);
    this.parts.delete(partId);
    if (part?.text === true && part.mode !== undefined) {
      if (part.mode !== "chat") this.emit(part.turnId ?? turnId, part.buffer);
      return;
    }
    // A part this reader didn't follow from its start, or one too short to
    // have ruled out a tag, is read from its final value.
    const owner = part?.turnId ?? turnId;
    const { mode, text } = replyModeOf(value);
    if ((mode ?? this.untagged(owner)) !== "chat") this.emit(owner, text);
  }

  private emit(turnId: string | undefined, text: string): void {
    const spoken = toSpeech(text);
    if (spoken) this.say(turnId ?? "", spoken);
  }
}

/** Where the first complete sentence in `text` ends, or -1. */
function sentenceEnd(text: string): number {
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
function toSpeech(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/https?:\/\/\S+/gu, "")
    .replace(/[*_`#>]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}
