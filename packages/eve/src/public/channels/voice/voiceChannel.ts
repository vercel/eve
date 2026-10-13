import type { SessionAuthContext } from "#channel/types.js";
import { createLogger, logError } from "#internal/logging.js";
import { transcriptionModel, speechModel } from "#internal/voice/gateway-voice-models.js";
import { createSentenceChunker } from "#internal/voice/sentence-chunker.js";
import { synthesizeSpeech } from "#internal/voice/synthesize.js";
import { transcribeAudio } from "#internal/voice/transcribe.js";
import { routeAuth, type AuthFn } from "#public/channels/auth.js";
import {
  defineChannel,
  WS,
  type Channel,
  type SendFn,
  type WebSocketMessage,
  type WebSocketPeer,
  type WebSocketRouteHooks,
} from "#public/definitions/defineChannel.js";
import {
  parseVoiceClientMessage,
  serializeVoiceServerMessage,
  type VoiceServerMessage,
} from "#public/channels/voice/protocol.js";

const log = createLogger("voice.channel");

const DEFAULT_ROUTE = "/eve/v1/voice";
const DEFAULT_TRANSCRIPTION_MODEL = "openai/whisper-1";
const DEFAULT_SPEECH_MODEL = "openai/tts-1";
const DEFAULT_VOICE = "alloy";
const DEFAULT_OUTPUT_FORMAT = "mp3";

/** Speech-to-text settings for {@link voiceChannel}. */
export interface VoiceTranscriptionConfig {
  /** Gateway transcription model id. Defaults to `"openai/whisper-1"`. */
  readonly model?: string;
}

/** Text-to-speech settings for {@link voiceChannel}. */
export interface VoiceSpeechConfig {
  /** Gateway speech model id. Defaults to `"openai/tts-1"`. */
  readonly model?: string;
  /** Provider voice. Defaults to `"alloy"`. */
  readonly voice?: string;
  /** Audio container/codec sent to the client. Defaults to `"mp3"`. */
  readonly outputFormat?: string;
  /** Free-form delivery guidance passed to the speech model. */
  readonly instructions?: string;
  /** Playback speed multiplier. */
  readonly speed?: number;
}

/** Configuration for {@link voiceChannel}. */
export interface VoiceChannelConfig {
  /**
   * Route auth, evaluated on the WebSocket upgrade. Reuse the shared helpers
   * from `eve/channels/auth` (e.g. `[vercelOidc(), localDev()]`); a failed walk
   * rejects the handshake.
   */
  readonly auth: AuthFn<Request> | readonly AuthFn<Request>[];
  /** WebSocket route path. Defaults to `/eve/v1/voice`. */
  readonly route?: string;
  readonly transcription?: VoiceTranscriptionConfig;
  readonly speech?: VoiceSpeechConfig;
  /** Optional line spoken to the caller as soon as the socket opens. */
  readonly greeting?: string;
}

/** Concrete return type of {@link voiceChannel}. */
export interface VoiceChannel extends Channel {}

/**
 * Realtime voice channel: talk to the agent over a WebSocket.
 *
 * Each connection is one conversation. A client sends one spoken utterance per
 * binary frame; the channel transcribes it (Gateway speech-to-text), delivers
 * the transcript to a durable agent session, and speaks the streamed reply back
 * one sentence at a time (Gateway text-to-speech). Because the durable agent
 * runs the turn, the full framework — instructions, tools, skills, subagents,
 * and multi-turn memory — is available by voice.
 *
 * Transcription and synthesis are batch, not streaming, so the client decides
 * where an utterance ends (typically push-to-talk) and replies are synthesized
 * per sentence to start playback before the whole reply is ready. See
 * `protocol.ts` for the frame convention (binary = audio, text = JSON control).
 */
export function voiceChannel(config: VoiceChannelConfig): VoiceChannel {
  const route = config.route ?? DEFAULT_ROUTE;
  const sttModelId = config.transcription?.model ?? DEFAULT_TRANSCRIPTION_MODEL;
  const ttsModelId = config.speech?.model ?? DEFAULT_SPEECH_MODEL;
  const voice = config.speech?.voice ?? DEFAULT_VOICE;
  const outputFormat = config.speech?.outputFormat ?? DEFAULT_OUTPUT_FORMAT;

  return defineChannel({
    kindHint: "voice",
    routes: [
      WS(route, (_req, { send }) =>
        createVoiceConnection({ config, send, sttModelId, ttsModelId, voice, outputFormat }),
      ),
    ],
  });
}

interface VoiceConnectionDeps {
  readonly config: VoiceChannelConfig;
  readonly send: SendFn;
  readonly sttModelId: string;
  readonly ttsModelId: string;
  readonly voice: string;
  readonly outputFormat: string;
}

/**
 * Builds the per-connection WebSocket hooks. Exposed for tests; channel authors
 * use {@link voiceChannel}.
 */
export function createVoiceConnection(deps: VoiceConnectionDeps): WebSocketRouteHooks {
  const { config, send, sttModelId, ttsModelId, voice, outputFormat } = deps;
  const sttModel = transcriptionModel(sttModelId);
  const ttsModel = speechModel(ttsModelId);

  // One conversation per socket: a stable continuation token threads every turn
  // through the same durable session, and a global event cursor keeps each turn
  // reading only the events it produced.
  const continuationToken = crypto.randomUUID();
  let auth: SessionAuthContext | null = null;
  let nextEventIndex = 0;
  let activeTurn: AbortController | null = null;

  const tell = (peer: WebSocketPeer, message: VoiceServerMessage): void => {
    peer.send(serializeVoiceServerMessage(message));
  };

  const speak = async (peer: WebSocketPeer, text: string, signal: AbortSignal): Promise<void> => {
    const result = await synthesizeSpeech({
      model: ttsModel,
      text,
      voice,
      outputFormat,
      instructions: config.speech?.instructions,
      speed: config.speech?.speed,
      abortSignal: signal,
    });
    if (signal.aborted) return;
    tell(peer, { type: "assistant_text", text });
    peer.send(result.audio);
  };

  const runTurn = async (peer: WebSocketPeer, input: string): Promise<void> => {
    activeTurn?.abort();
    const controller = new AbortController();
    activeTurn = controller;
    const { signal } = controller;
    const chunker = createSentenceChunker();
    let speaking = false;

    const startSpeaking = (): void => {
      if (!speaking) {
        tell(peer, { type: "status", state: "speaking" });
        speaking = true;
      }
    };

    try {
      tell(peer, { type: "status", state: "thinking" });
      const session = await send(input, { auth, continuationToken, mode: "conversation" });
      const stream = await session.getEventStream({ startIndex: nextEventIndex });
      const reader = stream.getReader();
      try {
        while (!signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          nextEventIndex += 1;

          if (value.type === "message.appended") {
            for (const chunk of chunker.push(value.data.messageDelta)) {
              startSpeaking();
              await speak(peer, chunk, signal);
              if (signal.aborted) break;
            }
          } else if (value.type === "message.completed") {
            const remainder = chunker.flush();
            if (remainder !== null) {
              startSpeaking();
              await speak(peer, remainder, signal);
            }
          } else if (isTurnEndEvent(value.type)) {
            break;
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
      }

      if (!signal.aborted) {
        tell(peer, { type: "status", state: "idle" });
      }
    } catch (error) {
      if (!signal.aborted) {
        logError(log, "voice turn failed", error);
        tell(peer, { type: "error", message: "The voice turn failed." });
        tell(peer, { type: "status", state: "idle" });
      }
    } finally {
      if (activeTurn === controller) {
        activeTurn = null;
      }
    }
  };

  const handleUtterance = async (peer: WebSocketPeer, audio: Uint8Array): Promise<void> => {
    let transcript: string;
    try {
      const result = await transcribeAudio({ model: sttModel, audio });
      transcript = result.text.trim();
    } catch (error) {
      logError(log, "voice transcription failed", error);
      tell(peer, { type: "error", message: "Could not transcribe the audio." });
      return;
    }

    tell(peer, { type: "user_transcript", text: transcript });
    if (transcript.length === 0) {
      tell(peer, { type: "status", state: "idle" });
      return;
    }
    await runTurn(peer, transcript);
  };

  return {
    async upgrade(request) {
      const result = await routeAuth(request, config.auth);
      if (result instanceof Response) {
        return result;
      }
      auth = result;
    },

    open(peer) {
      tell(peer, { type: "ready", audioFormat: outputFormat });
      const greeting = config.greeting?.trim();
      if (greeting !== undefined && greeting.length > 0) {
        void speakGreeting(peer, greeting);
      }
    },

    message(peer, message) {
      const controlText = readControlText(message);
      if (controlText !== null) {
        handleControl(peer, controlText);
        return;
      }
      // A new utterance interrupts whatever the agent is currently saying.
      activeTurn?.abort();
      void handleUtterance(peer, message.uint8Array());
    },

    close() {
      activeTurn?.abort();
      activeTurn = null;
    },

    error() {
      activeTurn?.abort();
      activeTurn = null;
    },
  };

  function handleControl(peer: WebSocketPeer, text: string): void {
    const message = parseVoiceClientMessage(text);
    if (message === null) {
      return;
    }
    if (message.type === "barge_in") {
      activeTurn?.abort();
      activeTurn = null;
      tell(peer, { type: "status", state: "idle" });
      return;
    }
    const trimmed = message.text.trim();
    if (trimmed.length === 0) {
      return;
    }
    activeTurn?.abort();
    void runTurn(peer, trimmed);
  }

  async function speakGreeting(peer: WebSocketPeer, greeting: string): Promise<void> {
    const controller = new AbortController();
    try {
      tell(peer, { type: "status", state: "speaking" });
      await speak(peer, greeting, controller.signal);
      tell(peer, { type: "status", state: "idle" });
    } catch (error) {
      logError(log, "voice greeting failed", error);
    }
  }
}

const TURN_END_EVENTS: ReadonlySet<string> = new Set([
  "turn.completed",
  "turn.failed",
  "session.completed",
  "session.failed",
  "input.requested",
]);

function isTurnEndEvent(type: string): boolean {
  return TURN_END_EVENTS.has(type);
}

/**
 * Returns the frame's text when it is a control frame, or `null` when it is a
 * binary audio frame. The two WebSocket frame kinds are the discriminator: a
 * string payload is JSON control, anything else is audio.
 */
function readControlText(message: WebSocketMessage): string | null {
  if (typeof message.rawData === "string") {
    return message.rawData;
  }
  if (typeof message.data === "string") {
    return message.data;
  }
  return null;
}
