import { randomUUID } from "node:crypto";

import {
  callRecallApi,
  recallBotConfig,
  resolveRecallWebhookUrl,
  type RecallChannelState,
} from "@eve/recall";
import { gateway, generateSpeech } from "ai";
import { GET, type RouteDefinition, type RouteHandlerArgs } from "eve/channels";

import { SpeechSegmenter } from "./speech-segmenter.js";
import { VOICE_ENABLED } from "./voice-mode.js";
import { VOICE_PAGE_HTML } from "./voice-page.js";

/** Bot metadata key holding the secret in the bot's voice page URL. */
const VOICE_KEY = "eve_voice_key";
const SPEECH_MODEL = process.env.VOICE_SPEECH_MODEL ?? "openai/tts-1";
const SPEECH_VOICE = process.env.VOICE_SPEECH_VOICE ?? "alloy";
/** How long a key's bot lookup is reused, so reconnects don't each call Recall's List Bots. */
const BOT_LOOKUP_TTL_MS = 60_000;
/** Bot statuses after which the meeting is over and its page has nothing left to play. */
const ENDED_STATUSES = new Set(["call_ended", "done", "fatal"]);
/** How long the stream waits for the session to fail on open before answering 200. */
const STREAM_OPEN_GRACE_MS = 1_000;

/**
 * The `POST /bot/` body for one meeting bot: the channel's config plus an
 * Output Media page at `<webhook route>/voice`. The page URL carries a random
 * key, stored in the bot's metadata, that the page trades for the bot's
 * session, so build a new body for every bot. The webhook URL's query, such as
 * a protection bypass, carries over. `webhookUrl` defaults to
 * `RECALL_WEBHOOK_URL`, or the production URL on Vercel.
 */
export function meetingBotConfig(input: {
  readonly meetingUrl: string;
  readonly greeting?: string;
  readonly webhookUrl?: string;
}): Record<string, unknown> {
  const key = randomUUID();
  const webhookUrl = resolveRecallWebhookUrl(input.webhookUrl);
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
 * Follows the meeting's session and answers with NDJSON: when a turn starts
 * and settles, and, with voice on, each sentence the agent writes, synthesized
 * as MP3, in order. `cursor` resumes after the last line the page saw; a first
 * connect starts at the session's tail.
 */
async function streamSpeech(
  request: Request,
  { resolveSession }: RouteHandlerArgs<RecallChannelState>,
): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const key = query.get("key") ?? "";
  if (!/^[0-9a-f-]{36}$/u.test(key)) return new Response("not found", { status: 404 });
  const bot = await botForKey(key);
  if (bot === undefined) return new Response("not found", { status: 404 });
  if (bot.ended) return new Response("meeting ended", { status: 410 });
  // The session starts with the bot's first meeting event; the page retries until then.
  const session = await resolveSession(bot.id);
  if (session === undefined) return new Response("not ready", { status: 425 });

  const cursor = Number(query.get("cursor") ?? Number.NaN);
  const resuming = Number.isInteger(cursor) && cursor >= 0;
  const encoder = new TextEncoder();
  const events = session
    .stream({ signal: request.signal, startIndex: resuming ? cursor : -1 })
    [Symbol.asyncIterator]();
  // A stream that fails to open, such as for a stranded session, fails at once.
  // Answer that with an error the page backs off from, not an empty 200.
  const first = events.next();
  const failed = await Promise.race([
    first.then(
      () => undefined,
      (error: unknown) => ({ error }),
    ),
    new Promise<undefined>((resolve) => setTimeout(resolve, STREAM_OPEN_GRACE_MS)),
  ]);
  if (failed !== undefined) {
    console.error("voice: session stream failed to open", failed.error);
    void events.return?.().catch(() => undefined);
    return new Response("stream unavailable", { status: 503 });
  }

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Speech is generated in parallel but written in order. Each message's
      // failure is handled as soon as it's created, since a later one can fail
      // while an earlier one is still pending.
      let chain: Promise<void> = Promise.resolve();
      const write = (message: Promise<object | undefined>) => {
        const settled = message.catch((error: unknown) => {
          console.error("voice: speech failed", error);
          return undefined;
        });
        chain = chain.then(async () => {
          const value = await settled;
          if (value === undefined || request.signal.aborted) return;
          controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
        });
      };
      const segmenter = new SpeechSegmenter(
        ({ partId, text, turnId }) => {
          if (VOICE_ENABLED)
            write(speak(text).then((audio) => ({ audio, partId, text, turnId, type: "say" })));
        },
        { resumed: resuming },
      );

      // Starting at the tail rereads its last line, which was already played.
      let skipLine: number | undefined;
      try {
        for (let next = await first; next.done !== true; next = await events.next()) {
          const event = next.value;
          const { line } = event.meta.position;
          if (!resuming) skipLine ??= line;
          if (line === skipLine) continue;

          // The page shows that eve is thinking from when a turn starts until it settles or waits on someone.
          if (event.type === "turn.started") {
            write(Promise.resolve({ thinking: true, type: "turn" }));
          } else if (event.type === "turn.settled" || event.type === "turn.paused") {
            write(Promise.resolve({ thinking: false, type: "turn" }));
          } else if (event.type === "delivery.consumed") {
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
            const nextLine = event.meta.next ?? line + 1;
            write(Promise.resolve({ cursor: nextLine, type: "cursor" }));
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

interface RecallBotSummary {
  readonly id: string;
  readonly status?: { readonly code?: string };
  readonly status_changes?: readonly { readonly code?: string }[];
}

const botLookups = new Map<
  string,
  { readonly bot: { id: string; ended: boolean } | undefined; readonly expires: number }
>();

/**
 * The bot whose metadata holds `key`, so a page URL only ever reads its own
 * meeting. Lookups are cached briefly per instance, since Recall limits how
 * often List Bots can be called.
 */
async function botForKey(key: string): Promise<{ id: string; ended: boolean } | undefined> {
  const now = Date.now();
  const cached = botLookups.get(key);
  if (cached !== undefined && cached.expires > now) return cached.bot;
  for (const [stale, entry] of botLookups) if (entry.expires <= now) botLookups.delete(stale);

  const page = await callRecallApi<{ results?: RecallBotSummary[] }>({
    path: `/bot/?metadata__${VOICE_KEY}=${encodeURIComponent(key)}`,
  });
  const bots = page.results ?? [];
  if (bots.length !== 1) {
    // Several bots share a key when one `meetingBotConfig` body was reused; build one per bot.
    console.warn(
      bots.length === 0
        ? "voice: no Recall bot has this page's key"
        : `voice: ${bots.length} Recall bots share this page's key; build a new meetingBotConfig body for each bot`,
    );
  }
  const found = bots.length === 1 ? bots[0]! : undefined;
  const code = found?.status?.code ?? found?.status_changes?.at(-1)?.code;
  const bot = found && { ended: code !== undefined && ENDED_STATUSES.has(code), id: found.id };
  botLookups.set(key, { bot, expires: now + BOT_LOOKUP_TTL_MS });
  return bot;
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
