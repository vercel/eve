import { createHmac, timingSafeEqual } from "node:crypto";

/** One final transcript utterance or meeting chat message, from a Recall real-time webhook. */
export interface MeetingEvent {
  readonly botId: string;
  readonly source: "speech" | "chat" | "join";
  readonly speaker: string;
  readonly text: string;
}

export const BOT_NAME = "eve";
export const RECALL_AUTHENTICATOR = "recall-webhook";

// Joins give the session an early turn to get ready before anyone asks.
const REALTIME_EVENTS = [
  "transcript.data",
  "participant_events.chat_message",
  "participant_events.join",
];

// Google Meet rejects chat messages over 500 characters, the lowest limit Recall documents.
const MAX_CHAT_MESSAGE_CHARS = 500;
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

export function createBot(input: { readonly meetingUrl: string; readonly webhookUrl: string }) {
  return recallRequest<{ readonly id: string }>("/bot/", {
    bot_name: BOT_NAME,
    chat: {
      on_bot_join: {
        send_to: "everyone",
        message: `Hi, I'm ${BOT_NAME}. Say my name or message me here to open or update a Linear issue.`,
      },
    },
    meeting_url: input.meetingUrl,
    recording_config: {
      transcript: {
        provider: { recallai_streaming: { language_code: "en", mode: "prioritize_low_latency" } },
      },
      realtime_endpoints: [{ type: "webhook", url: input.webhookUrl, events: REALTIME_EVENTS }],
    },
  });
}

export async function sendChatMessage(botId: string, message: string): Promise<void> {
  for (const chunk of chunkText(message, MAX_CHAT_MESSAGE_CHARS)) {
    await recallRequest(`/bot/${encodeURIComponent(botId)}/send_chat_message/`, {
      message: chunk,
    });
  }
}

async function recallRequest<T = unknown>(path: string, body: unknown): Promise<T> {
  const apiKey = process.env.RECALL_API_KEY;
  if (!apiKey) throw new Error("RECALL_API_KEY is not set.");
  const region = process.env.RECALL_REGION || "us-east-1";

  const response = await fetch(`https://${region}.recall.ai/api/v1${path}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Token ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Recall ${path} returned HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

/**
 * Verifies the Svix-style signature Recall puts on real-time webhooks when the
 * workspace has a verification secret.
 */
export function verifyRecallWebhook(headers: Headers, payload: string, secret: string): boolean {
  const id = headers.get("webhook-id") ?? headers.get("svix-id");
  const timestamp = headers.get("webhook-timestamp") ?? headers.get("svix-timestamp");
  const signatures = headers.get("webhook-signature") ?? headers.get("svix-signature");
  if (!id || !timestamp || !signatures) return false;

  const seconds = Number(timestamp);
  if (
    !Number.isInteger(seconds) ||
    Math.abs(Date.now() / 1000 - seconds) > SIGNATURE_TOLERANCE_SECONDS
  ) {
    return false;
  }

  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${payload}`).digest();
  return signatures.split(" ").some((candidate) => {
    const [version, signature] = candidate.split(",", 2);
    if (version !== "v1" || !signature) return false;
    const received = Buffer.from(signature, "base64");
    return received.length === expected.length && timingSafeEqual(received, expected);
  });
}

/** Returns `null` for events this agent ignores. */
export function parseMeetingEvent(payload: unknown): MeetingEvent | null {
  if (!isRecord(payload) || !isRecord(payload.data)) return null;
  const envelope = payload.data;
  const botId = isRecord(envelope.bot) ? envelope.bot.id : undefined;
  const data = isRecord(envelope.data) ? envelope.data : undefined;
  if (typeof botId !== "string" || !data) return null;

  const participant = isRecord(data.participant) ? data.participant : {};
  const speaker =
    typeof participant.name === "string" && participant.name.trim()
      ? participant.name.trim()
      : "Unknown participant";

  let text: string | undefined;
  let source: MeetingEvent["source"];
  if (payload.event === "transcript.data" && Array.isArray(data.words)) {
    source = "speech";
    text = data.words
      .map((word) => (isRecord(word) && typeof word.text === "string" ? word.text : ""))
      .join(" ");
  } else if (payload.event === "participant_events.chat_message" && isRecord(data.data)) {
    source = "chat";
    text = typeof data.data.text === "string" ? data.data.text : undefined;
  } else if (payload.event === "participant_events.join") {
    source = "join";
    text = "joined the meeting.";
  } else {
    return null;
  }

  const normalized = text
    ?.replace(/\s+([,.!?;:])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? { botId, source, speaker, text: normalized } : null;
}

function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > size) {
    const cut = rest.lastIndexOf(" ", size);
    const end = cut > size / 2 ? cut : size;
    chunks.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
