"use client";

import { experimental_useRealtime } from "@ai-sdk/react";
import { Client } from "#client/client.js";
import type { ClientSession } from "#client/session.js";
import type { ClientAuth, HeadersValue } from "#client/types.js";
import { EVE_VOICE_SETUP_ROUTE_PATH, voiceSetupUrl } from "#client/voice.js";
import type {
  Experimental_RealtimeClientEvent,
  Experimental_RealtimeModel,
  Experimental_RealtimeServerEvent,
  Experimental_RealtimeSessionConfig,
} from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const DEFAULT_MODEL = "openai/gpt-realtime-2";
const GATEWAY_REALTIME_SUBPROTOCOL = "ai-gateway-realtime.v1";
const GATEWAY_AUTH_SUBPROTOCOL_PREFIX = "ai-gateway-auth.";
const EVE_SPEAK_PREFIX = "EVE_SPEAK:";
const ECHO_SUPPRESSION_MS = 900;
// Bounds the deduplication set so a long-lived session does not grow it without
// limit; finalized transcription item ids are only revisited within a few turns.
const MAX_TRACKED_INPUT_ITEMS = 256;

type StoppableMediaStream = {
  getTracks(): readonly { stop(): void }[];
};

export interface UseEveVoiceOptions {
  readonly context?: string | readonly string[];
  readonly model?: string;
  readonly sessionConfig?: EveVoiceConfig;
  readonly setupUrl?: string;
  readonly voiceSessionId?: string;
  /**
   * Spoken when a turn fails before producing any assistant text. Off by
   * default: a failed turn surfaces through `onError`/`status` instead of
   * speaking a canned line, and a fallback is never spoken when the turn
   * already produced a usable reply.
   */
  readonly fallbackReply?: string;
  /**
   * Run voice turns against an existing session/client instead of an internal
   * one. Pass `session` to share a `ClientSession`, `client` to reuse an
   * authenticated `Client`, or `host`/`auth`/`headers` to configure the
   * internal client. Read once when the hook first renders; remount to change.
   */
  readonly client?: Client;
  readonly session?: ClientSession;
  readonly host?: string;
  readonly auth?: ClientAuth;
  readonly headers?: HeadersValue;
  readonly onError?: (error: Error) => void;
  readonly onEvent?: (event: EveVoiceEvent) => void;
  readonly onTranscript?: (input: {
    readonly itemId: string;
    readonly transcript: string;
    readonly voiceSessionId: string;
  }) => Promise<string | void> | string | void;
  readonly onReply?: (reply: {
    readonly message: string;
    readonly sessionId: string;
    readonly streamIndex: number;
    readonly text: string;
  }) => void;
}

export type EveVoiceActivity =
  | "ready"
  | "connecting"
  | "listening"
  | "user-speaking"
  | "assistant-speaking"
  | "error";

export type EveVoiceStatus = "disconnected" | "connecting" | "connected" | "error";

export interface EveVoiceConfig {
  readonly instructions?: string;
  readonly inputAudioTranscription?: {
    readonly language?: string;
    readonly model?: string;
    readonly prompt?: string;
  };
  readonly outputAudioTranscription?: {
    readonly language?: string;
    readonly model?: string;
    readonly prompt?: string;
  };
  readonly outputAudioFormat?: {
    readonly rate?: number;
    readonly type: string;
  };
  readonly outputModalities?: ("audio" | "text")[];
  readonly providerOptions?: Record<string, unknown>;
  readonly turnDetection?: {
    readonly prefixPaddingMs?: number;
    readonly silenceDurationMs?: number;
    readonly threshold?: number;
    readonly type: "disabled" | "semantic-vad" | "server-vad";
  } | null;
  readonly voice?: string;
}

export type EveVoiceEvent =
  | { readonly raw: unknown; readonly sessionId?: string; readonly type: "session-created" }
  | { readonly raw: unknown; readonly type: "session-updated" }
  | { readonly itemId?: string; readonly raw: unknown; readonly type: "speech-started" }
  | { readonly itemId?: string; readonly raw: unknown; readonly type: "speech-stopped" }
  | {
      readonly itemId?: string;
      readonly previousItemId?: string;
      readonly raw: unknown;
      readonly type: "audio-committed";
    }
  | {
      readonly item: unknown;
      readonly itemId: string;
      readonly raw: unknown;
      readonly type: "conversation-item-added";
    }
  | {
      readonly itemId: string;
      readonly raw: unknown;
      readonly transcript: string;
      readonly type: "input-transcription-completed";
    }
  | { readonly raw: unknown; readonly responseId: string; readonly type: "response-created" }
  | {
      readonly raw: unknown;
      readonly responseId: string;
      readonly status: string;
      readonly type: "response-done";
    }
  | {
      readonly itemId: string;
      readonly raw: unknown;
      readonly responseId: string;
      readonly type: "output-item-added";
    }
  | {
      readonly itemId: string;
      readonly raw: unknown;
      readonly responseId: string;
      readonly type: "output-item-done";
    }
  | {
      readonly itemId: string;
      readonly raw: unknown;
      readonly responseId: string;
      readonly type: "content-part-added";
    }
  | {
      readonly itemId: string;
      readonly raw: unknown;
      readonly responseId: string;
      readonly type: "content-part-done";
    }
  | {
      readonly delta: string;
      readonly itemId: string;
      readonly raw: unknown;
      readonly responseId: string;
      readonly type: "audio-delta";
    }
  | {
      readonly itemId: string;
      readonly raw: unknown;
      readonly responseId: string;
      readonly type: "audio-done";
    }
  | {
      readonly delta: string;
      readonly itemId: string;
      readonly raw: unknown;
      readonly responseId: string;
      readonly type: "audio-transcript-delta";
    }
  | {
      readonly itemId: string;
      readonly raw: unknown;
      readonly responseId: string;
      readonly transcript?: string;
      readonly type: "audio-transcript-done";
    }
  | {
      readonly delta: string;
      readonly itemId: string;
      readonly raw: unknown;
      readonly responseId: string;
      readonly type: "text-delta";
    }
  | {
      readonly itemId: string;
      readonly raw: unknown;
      readonly responseId: string;
      readonly text?: string;
      readonly type: "text-done";
    }
  | {
      readonly callId: string;
      readonly delta: string;
      readonly itemId: string;
      readonly raw: unknown;
      readonly responseId: string;
      readonly type: "function-call-arguments-delta";
    }
  | {
      readonly arguments: string;
      readonly callId: string;
      readonly itemId: string;
      readonly name: string;
      readonly raw: unknown;
      readonly responseId: string;
      readonly type: "function-call-arguments-done";
    }
  | {
      readonly code?: string;
      readonly message: string;
      readonly raw: unknown;
      readonly type: "error";
    }
  | { readonly raw: unknown; readonly rawType: string; readonly type: "custom" };

export interface UseEveVoiceResult {
  readonly error: Error | undefined;
  readonly activity: EveVoiceActivity;
  readonly isCapturing: boolean;
  readonly isPlaying: boolean;
  readonly isUserSpeaking: boolean;
  readonly lastReply: string | undefined;
  readonly sessionId: string | undefined;
  readonly speak: (text: string) => void;
  readonly status: EveVoiceStatus;
  readonly stopPlayback: () => void;
  readonly streamIndex: number;
  readonly voiceSessionId: string;
  start(): Promise<void>;
  stop(): void;
}

export function useEveVoice(options: UseEveVoiceOptions = {}): UseEveVoiceResult {
  const voiceSessionIdRef = useRef(options.voiceSessionId ?? crypto.randomUUID());
  const voiceSessionId = voiceSessionIdRef.current;
  const sessionRef = useRef<ClientSession | undefined>(undefined);
  if (sessionRef.current === undefined) {
    sessionRef.current = resolveVoiceSession(options);
  }
  const session = sessionRef.current;
  const [error, setError] = useState<Error | undefined>(undefined);
  const [isUserSpeaking, setIsUserSpeaking] = useState(false);
  const [lastReply, setLastReply] = useState<string | undefined>(undefined);
  const [sessionId, setSessionId] = useState<string | undefined>(session.state.sessionId);
  const [streamIndex, setStreamIndex] = useState(session.state.streamIndex);
  const ignoreInputUntilRef = useRef(0);
  const processedInputItemsRef = useRef(new Set<string>());
  const requestResponseRef = useRef<((options?: { modalities?: string[] }) => void) | undefined>(
    undefined,
  );
  const responseInFlightRef = useRef(false);
  const mediaStreamRef = useRef<StoppableMediaStream | null>(null);
  const lastErrorRef = useRef<Error | undefined>(undefined);
  const startingRef = useRef(false);
  const stopAudioCaptureRef = useRef<(() => void) | undefined>(undefined);

  const model = useMemo(() => resolveRealtimeModel(options.model), [options.model]);
  const setupUrl = useMemo(
    () => voiceSetupUrl(options.setupUrl ?? EVE_VOICE_SETUP_ROUTE_PATH, voiceSessionId),
    [options.setupUrl, voiceSessionId],
  );
  const sessionConfig = useMemo(
    () =>
      buildSessionConfig({
        sessionConfig: options.sessionConfig,
        voiceSessionId,
      }),
    [options.sessionConfig, voiceSessionId],
  );

  const handleError = useCallback(
    (nextError: Error) => {
      lastErrorRef.current = nextError;
      setError(nextError);
      setIsUserSpeaking(false);
      options.onError?.(nextError);
    },
    [options.onError],
  );

  const handleRealtimeError = useCallback(
    (nextError: Error) => {
      // A realtime/transport failure leaves the session unusable — including one
      // that surfaces after a successful connect — so release the microphone.
      // Per-turn failures go through handleError directly and keep the mic open.
      stopAudioCaptureRef.current?.();
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
      handleError(nextError);
    },
    [handleError],
  );

  const speakEveReply = useCallback((text: string) => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;

    sendEventRef.current?.({
      type: "conversation-item-create",
      item: {
        type: "text-message",
        role: "user",
        text: `${EVE_SPEAK_PREFIX}\n${trimmed}`,
      },
    });
    requestResponseRef.current?.({ modalities: ["audio"] });
  }, []);

  const speakFallbackReply = useCallback(() => {
    const fallback = options.fallbackReply;
    if (fallback === undefined || fallback.trim().length === 0) return;
    setLastReply(fallback);
    speakEveReply(fallback);
  }, [options.fallbackReply, speakEveReply]);

  const runEveTurn = useCallback(
    async (message: string, itemId: string) => {
      if (options.onTranscript !== undefined) {
        const reply = await options.onTranscript({
          itemId,
          transcript: message,
          voiceSessionId,
        });
        if (typeof reply === "string" && reply.trim().length > 0) {
          setLastReply(reply);
          speakEveReply(reply);
        }
        return;
      }

      let replyText: string | undefined;
      let spokeReply = false;
      try {
        const turn: { message: string; clientContext?: string | readonly string[] } = { message };
        if (options.context !== undefined) turn.clientContext = options.context;
        const response = await session.send(turn);

        let failed = false;
        for await (const event of response) {
          if (
            event.type === "message.completed" &&
            event.data.finishReason !== "tool-calls" &&
            typeof event.data.message === "string" &&
            event.data.message.length > 0
          ) {
            replyText = event.data.message;
          } else if (event.type === "session.failed") {
            failed = true;
          }
        }

        setSessionId(session.state.sessionId);
        setStreamIndex(session.state.streamIndex);

        if (replyText !== undefined && replyText.trim().length > 0) {
          setLastReply(replyText);
          options.onReply?.({
            message,
            sessionId: response.sessionId,
            streamIndex: session.state.streamIndex,
            text: replyText,
          });
          speakEveReply(replyText);
          spokeReply = true;
          return;
        }

        // A terminal failure that produced no assistant text would be dead
        // air, so optionally speak the configured fallback.
        if (failed) speakFallbackReply();
      } catch (cause) {
        // Only fall back when this turn produced no usable reply, so a late
        // transport error cannot overwrite or double-speak a real answer.
        if (!spokeReply && (replyText === undefined || replyText.trim().length === 0)) {
          speakFallbackReply();
        }
        throw cause;
      }
    },
    [
      options.context,
      options.onReply,
      options.onTranscript,
      session,
      speakEveReply,
      speakFallbackReply,
      voiceSessionId,
    ],
  );

  const turnQueueRef = useRef(Promise.resolve());
  const enqueueEveTurn = useCallback(
    (message: string, itemId: string) => {
      turnQueueRef.current = turnQueueRef.current
        .catch(() => undefined)
        .then(() => runEveTurn(message, itemId))
        .catch((cause) => {
          const nextError = cause instanceof Error ? cause : new Error(String(cause));
          handleError(nextError);
        });
    },
    [handleError, runEveTurn],
  );

  const handleEvent = useCallback(
    (event: Experimental_RealtimeServerEvent) => {
      switch (event.type) {
        case "response-created":
          // Suppress user transcripts for the lifetime of ANY model response,
          // not only ones solicited via speak(). A server-VAD auto-response
          // would otherwise play with no in-flight flag set, and its own audio
          // could be transcribed back and enqueued as a spurious user turn.
          responseInFlightRef.current = true;
          break;
        case "response-done":
        case "error":
          responseInFlightRef.current = false;
          ignoreInputUntilRef.current = Date.now() + ECHO_SUPPRESSION_MS;
          break;
        case "speech-started":
          setIsUserSpeaking(true);
          break;
        case "speech-stopped":
        case "audio-committed":
          setIsUserSpeaking(false);
          break;
        case "input-transcription-completed":
          setIsUserSpeaking(false);
          if (processedInputItemsRef.current.has(event.itemId)) {
            break;
          }
          processedInputItemsRef.current.add(event.itemId);
          if (processedInputItemsRef.current.size > MAX_TRACKED_INPUT_ITEMS) {
            const oldest = processedInputItemsRef.current.values().next().value;
            if (oldest !== undefined) processedInputItemsRef.current.delete(oldest);
          }
          const transcript = event.transcript.trim();
          if (transcript.length === 0) {
            break;
          }
          if (responseInFlightRef.current || Date.now() < ignoreInputUntilRef.current) {
            break;
          }
          enqueueEveTurn(transcript, event.itemId);
          break;
      }
      options.onEvent?.(event as EveVoiceEvent);
    },
    [enqueueEveTurn, options.onEvent],
  );

  const sendEventRef = useRef<((event: Experimental_RealtimeClientEvent) => void) | undefined>(
    undefined,
  );
  const realtime = experimental_useRealtime({
    api: { token: setupUrl },
    model,
    onError: handleRealtimeError,
    onEvent: handleEvent,
    sessionConfig,
  });
  requestResponseRef.current = realtime.requestResponse;
  sendEventRef.current = realtime.sendEvent;
  stopAudioCaptureRef.current = realtime.stopAudioCapture;

  const stop = useCallback(() => {
    realtime.stopAudioCapture();
    realtime.stopPlayback();
    realtime.disconnect();
    ignoreInputUntilRef.current = 0;
    processedInputItemsRef.current.clear();
    responseInFlightRef.current = false;
    setIsUserSpeaking(false);
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
  }, [realtime]);
  const stopRef = useRef(stop);
  stopRef.current = stop;

  const start = useCallback(async () => {
    // Ignore re-entrant starts: a second in-flight or already-live session
    // would acquire another microphone stream and orphan the previous one.
    if (
      startingRef.current ||
      realtime.status === "connecting" ||
      realtime.status === "connected"
    ) {
      return;
    }
    startingRef.current = true;
    setError(undefined);
    lastErrorRef.current = undefined;
    try {
      const mediaStream = await getMicrophoneStream();
      mediaStreamRef.current = mediaStream;
      await realtime.connect();
      // The AI SDK's connect() resolves even when the realtime session fails to
      // open: it routes the failure through onError instead of rejecting. Treat
      // a captured error as a thrown connection failure so the microphone is
      // released and audio capture never starts against a dead session.
      if (lastErrorRef.current !== undefined) {
        throw lastErrorRef.current;
      }
      realtime.startAudioCapture(mediaStream as Parameters<typeof realtime.startAudioCapture>[0]);
    } catch (cause) {
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
      const nextError = cause instanceof Error ? cause : new Error(String(cause));
      // Avoid double-reporting when onError already surfaced this error.
      if (nextError !== lastErrorRef.current) {
        handleError(nextError);
      }
    } finally {
      startingRef.current = false;
    }
  }, [handleError, realtime]);

  useEffect(() => () => stopRef.current(), []);

  return {
    activity: resolveActivity({
      isPlaying: realtime.isPlaying,
      isUserSpeaking,
      status: realtime.status,
    }),
    error,
    isCapturing: realtime.isCapturing,
    isPlaying: realtime.isPlaying,
    isUserSpeaking,
    lastReply,
    sessionId,
    speak: speakEveReply,
    start,
    status: realtime.status,
    stop,
    stopPlayback: realtime.stopPlayback,
    streamIndex,
    voiceSessionId,
  };
}

function resolveActivity(input: {
  readonly isPlaying: boolean;
  readonly isUserSpeaking: boolean;
  readonly status: EveVoiceStatus;
}): EveVoiceActivity {
  if (input.status === "error") return "error";
  if (input.status === "connecting") return "connecting";
  if (input.status !== "connected") return "ready";
  if (input.isUserSpeaking) return "user-speaking";
  if (input.isPlaying) return "assistant-speaking";
  return "listening";
}

function resolveVoiceSession(options: UseEveVoiceOptions): ClientSession {
  if (options.session !== undefined) return options.session;
  if (options.client !== undefined) return options.client.session();
  const clientOptions: { host: string; auth?: ClientAuth; headers?: HeadersValue } = {
    host: options.host ?? "",
  };
  if (options.auth !== undefined) clientOptions.auth = options.auth;
  if (options.headers !== undefined) clientOptions.headers = options.headers;
  const client = new Client(clientOptions);
  return client.session();
}

function buildSessionConfig(input: {
  readonly sessionConfig: EveVoiceConfig | undefined;
  readonly voiceSessionId: string;
}): Partial<Experimental_RealtimeSessionConfig> {
  const baseGatewayOptions = {
    tags: ["eve", "realtime-speech"],
    user: input.voiceSessionId,
  };
  const providerOptions = input.sessionConfig?.providerOptions;
  const gatewayOptions = asRecord(providerOptions?.gateway);

  return {
    instructions: [
      "You are a speech transport adapter for an Eve agent, not the assistant.",
      "Do not answer user speech directly and do not mention tools, waiting, or checking.",
      `Only speak when you receive a user message beginning with ${EVE_SPEAK_PREFIX}`,
      "When you receive that marker, read only the text after it exactly.",
    ].join(" "),
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    outputModalities: ["audio"],
    turnDetection: { type: "server-vad" },
    voice: "alloy",
    ...input.sessionConfig,
    providerOptions: {
      ...providerOptions,
      gateway: {
        ...baseGatewayOptions,
        ...gatewayOptions,
      },
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function resolveRealtimeModel(model: string | Experimental_RealtimeModel | undefined) {
  if (typeof model === "object" && model !== null) return model;
  return createGatewayRealtimeModel(model ?? DEFAULT_MODEL);
}

function createGatewayRealtimeModel(modelId: string): Experimental_RealtimeModel {
  return {
    specificationVersion: "v4",
    provider: "gateway.realtime",
    modelId,
    doCreateClientSecret() {
      throw new Error(
        "Eve voice mints Gateway realtime client secrets through the setup route, not in the browser.",
      );
    },
    getWebSocketConfig(options) {
      return {
        url: options.url,
        protocols: [
          GATEWAY_REALTIME_SUBPROTOCOL,
          `${GATEWAY_AUTH_SUBPROTOCOL_PREFIX}${options.token}`,
        ],
      };
    },
    parseServerEvent(raw: unknown): Experimental_RealtimeServerEvent {
      return raw as Experimental_RealtimeServerEvent;
    },
    serializeClientEvent(event: Experimental_RealtimeClientEvent): unknown {
      return event;
    },
    buildSessionConfig(config: Experimental_RealtimeSessionConfig): unknown {
      return config;
    },
  };
}

async function getMicrophoneStream(): Promise<StoppableMediaStream> {
  const mediaDevices = (
    globalThis as {
      readonly navigator?: {
        readonly mediaDevices?: {
          getUserMedia(input: { readonly audio: true }): Promise<StoppableMediaStream>;
        };
      };
    }
  ).navigator?.mediaDevices;

  if (mediaDevices === undefined) {
    throw new Error("Microphone capture is not available in this environment.");
  }
  return mediaDevices.getUserMedia({ audio: true });
}
