/**
 * Wire protocol for the realtime voice channel.
 *
 * The transport is a single WebSocket per conversation. The two frame kinds are
 * used as a discriminator, so no envelope is needed around audio:
 *
 * - **Binary frames** carry raw audio. Client → server: one complete spoken
 *   utterance (e.g. webm/opus). Server → client: synthesized speech in the
 *   channel's configured {@link VoiceReadyMessage.audioFormat}.
 * - **Text frames** carry JSON control messages ({@link VoiceServerMessage} /
 *   {@link VoiceClientMessage}).
 */

/** Audio container/codec of the binary audio frames, e.g. `"mp3"`. */
export type VoiceAudioFormat = string;

/** High-level state of the current voice turn, surfaced for client UI. */
export type VoiceTurnState = "thinking" | "speaking" | "idle";

/** Sent once when the socket opens, before any audio. */
export interface VoiceReadyMessage {
  readonly type: "ready";
  /** Container/codec every server binary audio frame will use. */
  readonly audioFormat: VoiceAudioFormat;
}

/** The transcript of the user's most recent spoken utterance. */
export interface VoiceUserTranscriptMessage {
  readonly type: "user_transcript";
  readonly text: string;
}

/** A chunk of the agent's reply, emitted alongside the audio frame that speaks it. */
export interface VoiceAssistantTextMessage {
  readonly type: "assistant_text";
  readonly text: string;
}

/** A turn-state transition for driving client UI. */
export interface VoiceStatusMessage {
  readonly type: "status";
  readonly state: VoiceTurnState;
}

/** A recoverable error during a turn; the socket stays open. */
export interface VoiceErrorMessage {
  readonly type: "error";
  readonly message: string;
}

/** A JSON control message sent from server to client over a text frame. */
export type VoiceServerMessage =
  | VoiceReadyMessage
  | VoiceUserTranscriptMessage
  | VoiceAssistantTextMessage
  | VoiceStatusMessage
  | VoiceErrorMessage;

/** Interrupts the in-flight turn so the user can talk over the agent. */
export interface VoiceBargeInMessage {
  readonly type: "barge_in";
}

/** Sends typed text as if the user had spoken it (skips transcription). */
export interface VoiceTextMessage {
  readonly type: "text";
  readonly text: string;
}

/** A JSON control message sent from client to server over a text frame. */
export type VoiceClientMessage = VoiceBargeInMessage | VoiceTextMessage;

/**
 * Parses a client control text frame. Returns `null` for malformed JSON or an
 * unrecognized message so the channel can safely ignore it.
 */
export function parseVoiceClientMessage(text: string): VoiceClientMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const type = (value as { type?: unknown }).type;
  if (type === "barge_in") {
    return { type: "barge_in" };
  }
  if (type === "text") {
    const text = (value as { text?: unknown }).text;
    if (typeof text === "string") {
      return { type: "text", text };
    }
  }
  return null;
}

/** Serializes a server control message to a JSON text frame. */
export function serializeVoiceServerMessage(message: VoiceServerMessage): string {
  return JSON.stringify(message);
}
