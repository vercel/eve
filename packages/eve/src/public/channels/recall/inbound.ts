import { isObject } from "#shared/guards.js";

/** A meeting participant as Recall reports them. Names and emails come from the meeting platform and are not verified. */
export interface RecallParticipant {
  /** Recall's participant id, unique within one bot's meeting. */
  readonly id: string;
  readonly name: string;
  readonly isHost: boolean;
  readonly email?: string;
}

interface RecallEventBase {
  readonly botId: string;
  /** Metadata set on the bot when it was created. */
  readonly botMetadata: Readonly<Record<string, string>>;
}

/** A final transcript utterance. */
export interface RecallSpeechEvent extends RecallEventBase {
  readonly type: "speech";
  readonly participant: RecallParticipant;
  readonly text: string;
}

/** A meeting chat message. */
export interface RecallChatEvent extends RecallEventBase {
  readonly type: "chat";
  readonly participant: RecallParticipant;
  readonly text: string;
  /** Who the message was sent to, such as `everyone` or `only_bot`. */
  readonly to: string | undefined;
}

/** A participant joined or left the meeting. */
export interface RecallParticipantEvent extends RecallEventBase {
  readonly type: "join" | "leave";
  readonly participant: RecallParticipant;
}

/** A bot status change, such as `call_ended` or `done`, from Recall's workspace status webhooks. */
export interface RecallStatusEvent extends RecallEventBase {
  readonly type: "status";
  /** The status without its `bot.` prefix, such as `in_call_recording`, `call_ended`, `done`, or `fatal`. */
  readonly status: string;
  readonly subCode: string | undefined;
}

/** One inbound Recall webhook, normalized. */
export type RecallMeetingEvent =
  | RecallSpeechEvent
  | RecallChatEvent
  | RecallParticipantEvent
  | RecallStatusEvent;

/** Real-time events the channel understands; pass these to the bot's `realtime_endpoints`. */
export const RECALL_REALTIME_EVENTS = [
  "transcript.data",
  "participant_events.chat_message",
  "participant_events.join",
  "participant_events.leave",
] as const;

/** Parses a Recall real-time or status webhook body. Returns `null` for events the channel ignores. */
export function parseRecallEvent(payload: unknown): RecallMeetingEvent | null {
  if (!isObject(payload) || typeof payload.event !== "string" || !isObject(payload.data)) {
    return null;
  }
  const envelope = payload.data;
  const bot = isObject(envelope.bot) ? envelope.bot : undefined;
  if (typeof bot?.id !== "string" || !isObject(envelope.data)) return null;
  const base: RecallEventBase = { botId: bot.id, botMetadata: readMetadata(bot.metadata) };
  const data = envelope.data;

  if (payload.event.startsWith("bot.")) {
    return {
      ...base,
      status: payload.event.slice("bot.".length),
      subCode: typeof data.sub_code === "string" ? data.sub_code : undefined,
      type: "status",
    };
  }

  const participant = readParticipant(data.participant);
  if (participant === undefined) return null;

  switch (payload.event) {
    case "transcript.data": {
      const text = Array.isArray(data.words)
        ? normalizeText(
            data.words
              .map((word) => (isObject(word) && typeof word.text === "string" ? word.text : ""))
              .join(" "),
          )
        : "";
      return text ? { ...base, participant, text, type: "speech" } : null;
    }
    case "participant_events.chat_message": {
      const message = isObject(data.data) ? data.data : {};
      const text = typeof message.text === "string" ? message.text.trim() : "";
      if (!text) return null;
      const to = typeof message.to === "string" ? message.to : undefined;
      return { ...base, participant, text, to, type: "chat" };
    }
    case "participant_events.join":
      return { ...base, participant, type: "join" };
    case "participant_events.leave":
      return { ...base, participant, type: "leave" };
    default:
      return null;
  }
}

function readParticipant(value: unknown): RecallParticipant | undefined {
  if (!isObject(value)) return undefined;
  const id = typeof value.id === "number" || typeof value.id === "string" ? String(value.id) : "";
  if (!id) return undefined;
  const name = typeof value.name === "string" && value.name.trim() ? value.name.trim() : "";
  return {
    email: typeof value.email === "string" && value.email ? value.email : undefined,
    id,
    isHost: value.is_host === true,
    name: name || "Unknown participant",
  };
}

function readMetadata(value: unknown): Readonly<Record<string, string>> {
  if (!isObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function normalizeText(text: string): string {
  return text
    .replace(/\s+([,.!?;:])/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
}
