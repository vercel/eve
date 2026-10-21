import { RECALL_REALTIME_EVENTS } from "#public/channels/recall/inbound.js";

/** `fetch`-compatible function used for Recall API calls. */
export type RecallFetch = typeof globalThis.fetch;

/** Shared options for Recall API calls. */
export interface RecallApiOptions {
  /** Recall API key. Defaults to `RECALL_API_KEY`. */
  readonly apiKey?: string;
  /** Recall workspace region, such as `us-east-1` or `eu-central-1`. Defaults to `RECALL_REGION`, then `us-east-1`. */
  readonly region?: string;
  /** Overrides the API origin derived from `region`. */
  readonly apiBaseUrl?: string;
  readonly fetch?: RecallFetch;
}

/** A failed Recall API call. `status` is the HTTP status. */
export class RecallApiError extends Error {
  readonly path: string;
  readonly status: number;
  readonly body: string;

  constructor(path: string, status: number, body: string) {
    super(`Recall ${path} returned HTTP ${status}: ${body.slice(0, 500)}`);
    this.name = "RecallApiError";
    this.path = path;
    this.status = status;
    this.body = body;
  }
}

/** Calls the Recall REST API. `path` is relative to `/api/v1`, such as `/bot/`. */
export async function callRecallApi<T = unknown>(
  input: RecallApiOptions & {
    readonly path: string;
    readonly method?: "GET" | "POST" | "DELETE" | "PATCH";
    readonly body?: unknown;
  },
): Promise<T> {
  const apiKey = (input.apiKey ?? process.env.RECALL_API_KEY)?.trim();
  if (!apiKey) {
    throw new Error(
      "recallChannel: RECALL_API_KEY is required to call Recall. Create one in the Recall dashboard or pass credentials.apiKey.",
    );
  }
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Token ${apiKey}`,
  };
  if (input.body !== undefined) headers["content-type"] = "application/json";
  const response = await (input.fetch ?? globalThis.fetch)(
    `${recallApiBaseUrl(input)}${input.path}`,
    {
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      headers,
      method: input.method ?? (input.body === undefined ? "GET" : "POST"),
    },
  );
  const text = await response.text();
  if (!response.ok) throw new RecallApiError(input.path, response.status, text);
  return (text ? JSON.parse(text) : null) as T;
}

function recallApiBaseUrl(options: RecallApiOptions): string {
  if (options.apiBaseUrl) return `${options.apiBaseUrl.replace(/\/+$/u, "")}/api/v1`;
  const region = options.region ?? (process.env.RECALL_REGION?.trim() || "us-east-1");
  return `https://${region}.recall.ai/api/v1`;
}

/**
 * Chat limits per meeting platform. Webex bots can't send chat, and only Zoom
 * delivers a message to one participant.
 */
const PLATFORM_CHAT = {
  google_meet: { maxChars: 500, directMessages: false },
  microsoft_teams: { maxChars: 4096, directMessages: false },
  zoom: { maxChars: 4096, directMessages: true },
} as const satisfies Record<string, { maxChars: number; directMessages: boolean }>;

/** The lowest documented limit, for platforms Recall hasn't told us about. */
const FALLBACK_CHAT = { maxChars: 500, directMessages: false };

/** Whether Recall can send a chat message to one participant on `platform`. */
export function recallSupportsDirectMessages(platform: string | undefined): boolean {
  return chatLimitsOf(platform).directMessages;
}

function chatLimitsOf(platform: string | undefined) {
  return (platform && PLATFORM_CHAT[platform as keyof typeof PLATFORM_CHAT]) || FALLBACK_CHAT;
}

/** Parameters for {@link sendRecallChatMessage}. */
export interface RecallSendChatMessageInput extends RecallApiOptions {
  readonly botId: string;
  readonly message: string;
  /** `everyone` (default), `host`, `everyone_except_host`, or a participant id. Only Zoom supports anything but `everyone`. */
  readonly to?: string;
  /** Meeting platform, used to split the message to its chat limit. */
  readonly platform?: string;
}

/** Posts a message to the meeting chat, split to fit the platform's limit. */
export async function sendRecallChatMessage(input: RecallSendChatMessageInput): Promise<void> {
  for (const chunk of chunkText(input.message, chatLimitsOf(input.platform).maxChars)) {
    await callRecallApi({
      ...input,
      body: input.to === undefined ? { message: chunk } : { message: chunk, to: input.to },
      path: `/bot/${encodeURIComponent(input.botId)}/send_chat_message/`,
    });
  }
}

/**
 * Plays an MP3 clip through the bot's microphone. The bot must have been
 * created with `automatic_audio_output` configured, or Recall rejects it.
 */
export async function outputRecallAudio(
  input: RecallApiOptions & { readonly botId: string; readonly mp3: Uint8Array },
): Promise<void> {
  await callRecallApi({
    ...input,
    body: { b64_data: Buffer.from(input.mp3).toString("base64"), kind: "mp3" },
    path: `/bot/${encodeURIComponent(input.botId)}/output_audio/`,
  });
}

/**
 * Streams a web page into the meeting as the bot's camera and microphone
 * (Recall Output Media). The page can play audio and read the meeting's audio
 * and live transcript. Not available in Slack huddles, and can't be combined
 * with `outputRecallAudio`.
 */
export async function startRecallOutputMedia(
  input: RecallApiOptions & { readonly botId: string; readonly url: string },
): Promise<void> {
  await callRecallApi({
    ...input,
    body: { camera: { config: { url: input.url }, kind: "webpage" } },
    path: `/bot/${encodeURIComponent(input.botId)}/output_media/`,
  });
}

/** Stops the page {@link startRecallOutputMedia} started. */
export async function stopRecallOutputMedia(
  input: RecallApiOptions & { readonly botId: string },
): Promise<void> {
  await callRecallApi({
    ...input,
    body: { camera: true },
    method: "DELETE",
    path: `/bot/${encodeURIComponent(input.botId)}/output_media/`,
  });
}

/** Removes the bot from its meeting. */
export async function leaveRecallCall(
  input: RecallApiOptions & { readonly botId: string },
): Promise<void> {
  await callRecallApi({
    ...input,
    method: "POST",
    path: `/bot/${encodeURIComponent(input.botId)}/leave_call/`,
  });
}

/** Options for {@link recallBotConfig}. */
export interface RecallBotConfigInput {
  readonly meetingUrl: string;
  /** Public HTTPS URL of the channel's webhook route. */
  readonly webhookUrl: string;
  /** Display name in the meeting. Defaults to `eve`. */
  readonly botName?: string;
  /** Metadata Recall echoes on every webhook for this bot. */
  readonly metadata?: Readonly<Record<string, string>>;
  /** Chat message the bot posts when it joins. */
  readonly greeting?: string;
  /** Web page the bot streams as its camera and microphone from the start. See {@link startRecallOutputMedia}. */
  readonly outputMediaUrl?: string;
}

/**
 * The `POST /bot/` body the channel needs: low-latency streaming transcription
 * and a real-time webhook for every event the channel understands. Spread it
 * into your own body for options eve doesn't model, or reuse it for Recall's
 * calendar auto-join bot config.
 */
export function recallBotConfig(input: RecallBotConfigInput): Record<string, unknown> {
  const config: Record<string, unknown> = {
    bot_name: input.botName ?? "eve",
    meeting_url: input.meetingUrl,
    recording_config: {
      realtime_endpoints: [
        { events: [...RECALL_REALTIME_EVENTS], type: "webhook", url: input.webhookUrl },
      ],
      // Recall's low-latency mode is English-only; its default accuracy mode
      // delivers real-time transcripts minutes late. Swap in a third-party
      // streaming provider for other languages.
      transcript: {
        provider: {
          recallai_streaming: { language_code: "en", mode: "prioritize_low_latency" },
        },
      },
    },
  };
  if (input.metadata !== undefined) config.metadata = input.metadata;
  if (input.outputMediaUrl !== undefined) {
    config.output_media = { camera: { config: { url: input.outputMediaUrl }, kind: "webpage" } };
  }
  if (input.greeting !== undefined) {
    config.chat = { on_bot_join: { message: input.greeting, send_to: "everyone" } };
  }
  return config;
}

/** A Recall bot: its id and meeting platform, such as `zoom` or `google_meet`. */
export interface RecallBot {
  readonly id: string;
  readonly platform?: string;
}

interface RecallBotResponse {
  readonly id: string;
  readonly meeting_url?: { readonly platform?: unknown } | null;
}

/** Sends a Recall bot to a meeting. */
export async function createRecallBot(
  input: RecallApiOptions & { readonly body: Record<string, unknown> },
): Promise<RecallBot> {
  return toRecallBot(await callRecallApi<RecallBotResponse>({ ...input, path: "/bot/" }));
}

/** Looks up a Recall bot by id. */
export async function getRecallBot(
  input: RecallApiOptions & { readonly botId: string },
): Promise<RecallBot> {
  return toRecallBot(
    await callRecallApi<RecallBotResponse>({
      ...input,
      path: `/bot/${encodeURIComponent(input.botId)}/`,
    }),
  );
}

// Participants carry a `platform` too, but it's how they joined ("desktop",
// "dial_in"), not the meeting platform.
function toRecallBot(bot: RecallBotResponse): RecallBot {
  const platform = bot.meeting_url?.platform;
  return typeof platform === "string" ? { id: bot.id, platform } : { id: bot.id };
}

function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > size) {
    // Prefer a line break, then a space, so options and links stay whole.
    const newline = rest.lastIndexOf("\n", size);
    const space = rest.lastIndexOf(" ", size);
    const cut = newline > size / 2 ? newline : space > size / 2 ? space : size;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
