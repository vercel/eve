"use client";

import { experimental_useRealtime } from "@ai-sdk/react";
import {
  EVE_VOICE_SETUP_ROUTE_PATH,
  EVE_VOICE_TURN_ROUTE_PATH,
  EveVoiceSession,
} from "#client/voice.js";
import type {
  Experimental_RealtimeClientEvent,
  Experimental_RealtimeModel,
  Experimental_RealtimeServerEvent,
  Experimental_RealtimeSessionConfig,
  Experimental_RealtimeStatus,
  UIMessage,
} from "ai";
import {
  createElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

const DEFAULT_MODEL = "openai/gpt-realtime-2";
const GATEWAY_REALTIME_SUBPROTOCOL = "ai-gateway-realtime.v1";
const GATEWAY_AUTH_SUBPROTOCOL_PREFIX = "ai-gateway-auth.";
const EVE_SPEAK_PREFIX = "EVE_SPEAK:";
const ECHO_SUPPRESSION_MS = 900;

type StoppableMediaStream = {
  getTracks(): readonly { stop(): void }[];
};

export interface UseEveVoiceOptions {
  readonly context?: string | readonly string[];
  readonly model?: string | Experimental_RealtimeModel;
  readonly sessionConfig?: Partial<Experimental_RealtimeSessionConfig>;
  readonly setupUrl?: string;
  readonly turnUrl?: string;
  readonly voiceSessionId?: string;
  readonly onError?: (error: Error) => void;
  readonly onEvent?: (event: Experimental_RealtimeServerEvent) => void;
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

export interface UseEveVoiceResult {
  readonly error: Error | undefined;
  readonly activity: EveVoiceActivity;
  readonly events: ReturnType<typeof experimental_useRealtime>["events"];
  readonly isCapturing: boolean;
  readonly isPlaying: boolean;
  readonly isUserSpeaking: boolean;
  readonly lastReply: string | undefined;
  readonly messages: UIMessage[];
  readonly sessionId: string | undefined;
  readonly speak: (text: string) => void;
  readonly status: Experimental_RealtimeStatus;
  readonly stopPlayback: () => void;
  readonly streamIndex: number;
  readonly voiceSessionId: string;
  start(): Promise<void>;
  stop(): void;
}

export interface VoiceButtonProps extends UseEveVoiceOptions {
  readonly children?: ReactNode;
  readonly className?: string;
  readonly disabled?: boolean;
}

export function useEveVoice(options: UseEveVoiceOptions = {}): UseEveVoiceResult {
  const voiceSession = useMemo(
    () =>
      new EveVoiceSession({
        setupUrl: options.setupUrl ?? EVE_VOICE_SETUP_ROUTE_PATH,
        turnUrl: options.turnUrl ?? EVE_VOICE_TURN_ROUTE_PATH,
        ...(options.voiceSessionId !== undefined ? { voiceSessionId: options.voiceSessionId } : {}),
      }),
    [options.setupUrl, options.turnUrl, options.voiceSessionId],
  );
  const voiceSessionId = voiceSession.state.voiceSessionId;
  const [error, setError] = useState<Error | undefined>(undefined);
  const [isUserSpeaking, setIsUserSpeaking] = useState(false);
  const [lastReply, setLastReply] = useState<string | undefined>(undefined);
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [streamIndex, setStreamIndex] = useState(voiceSession.state.streamIndex);
  const expectSpeechResponseRef = useRef(false);
  const ignoreInputUntilRef = useRef(0);
  const processedInputItemsRef = useRef(new Set<string>());
  const requestResponseRef = useRef<((options?: { modalities?: string[] }) => void) | undefined>(
    undefined,
  );
  const responseInFlightRef = useRef(false);
  const mediaStreamRef = useRef<StoppableMediaStream | null>(null);

  const model = useMemo(() => resolveRealtimeModel(options.model), [options.model]);
  const setupUrl = useMemo(() => voiceSession.setupUrl, [voiceSession]);
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
      setError(nextError);
      setIsUserSpeaking(false);
      options.onError?.(nextError);
    },
    [options.onError],
  );

  const speakEveReply = useCallback((text: string) => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;

    expectSpeechResponseRef.current = true;
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

  const runEveTurn = useCallback(
    async (message: string) => {
      if (options.onTranscript !== undefined) {
        const reply = await options.onTranscript({
          itemId: latestInputItemIdRef.current ?? "",
          transcript: message,
          voiceSessionId,
        });
        if (typeof reply === "string" && reply.trim().length > 0) {
          setLastReply(reply);
          speakEveReply(reply);
        }
        return;
      }

      const data = await voiceSession.sendTranscript({ context: options.context, message });
      setSessionId(data.sessionId);
      setStreamIndex(data.streamIndex);
      setLastReply(data.text);
      options.onReply?.({
        message,
        sessionId: data.sessionId,
        streamIndex: data.streamIndex,
        text: data.text,
      });
      speakEveReply(data.text);
    },
    [
      options.context,
      options.onReply,
      options.onTranscript,
      speakEveReply,
      voiceSession,
      voiceSessionId,
    ],
  );

  const turnQueueRef = useRef(Promise.resolve());
  const latestInputItemIdRef = useRef<string | undefined>(undefined);
  const enqueueEveTurn = useCallback(
    (message: string) => {
      turnQueueRef.current = turnQueueRef.current
        .catch(() => undefined)
        .then(() => runEveTurn(message))
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
          if (!expectSpeechResponseRef.current) {
            break;
          }
          expectSpeechResponseRef.current = false;
          responseInFlightRef.current = true;
          break;
        case "response-done":
        case "error":
          responseInFlightRef.current = false;
          expectSpeechResponseRef.current = false;
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
          latestInputItemIdRef.current = event.itemId;
          const transcript = event.transcript.trim();
          if (transcript.length === 0) {
            break;
          }
          if (responseInFlightRef.current || Date.now() < ignoreInputUntilRef.current) {
            break;
          }
          responseInFlightRef.current = false;
          enqueueEveTurn(transcript);
          break;
      }
      options.onEvent?.(event);
    },
    [enqueueEveTurn, options.onEvent],
  );

  const sendEventRef = useRef<((event: Experimental_RealtimeClientEvent) => void) | undefined>(
    undefined,
  );
  const realtime = experimental_useRealtime({
    api: { token: setupUrl },
    model,
    onError: handleError,
    onEvent: handleEvent,
    sessionConfig,
  });
  requestResponseRef.current = realtime.requestResponse;
  sendEventRef.current = realtime.sendEvent;

  const stop = useCallback(() => {
    realtime.stopAudioCapture();
    realtime.stopPlayback();
    realtime.disconnect();
    expectSpeechResponseRef.current = false;
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
    setError(undefined);
    try {
      const mediaStream = await getMicrophoneStream();
      mediaStreamRef.current = mediaStream;
      await realtime.connect();
      realtime.startAudioCapture(mediaStream as Parameters<typeof realtime.startAudioCapture>[0]);
    } catch (cause) {
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
      const nextError = cause instanceof Error ? cause : new Error(String(cause));
      handleError(nextError);
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
    events: realtime.events,
    isCapturing: realtime.isCapturing,
    isPlaying: realtime.isPlaying,
    isUserSpeaking,
    lastReply,
    messages: realtime.messages,
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

export function VoiceButton(props: VoiceButtonProps) {
  const { children, className, disabled, ...voiceOptions } = props;
  const voice = useEveVoice(voiceOptions);
  const isActive = voice.status === "connected" || voice.status === "connecting";
  const label = voiceButtonLabel(voice.activity);

  return createElement(
    "button",
    {
      "aria-label": label,
      "aria-pressed": isActive,
      className,
      "data-status": voice.status,
      "data-voice-state": voice.activity,
      disabled: disabled === true || voice.status === "connecting",
      onClick: () => {
        if (isActive) {
          voice.stop();
          return;
        }
        void voice.start();
      },
      title: voice.error?.message ?? label,
      type: "button",
    },
    children ?? createElement(VoiceIcon, { activity: voice.activity }),
  );
}

function VoiceIcon({ activity }: { readonly activity: EveVoiceActivity }) {
  if (activity === "user-speaking") return createElement(SpeechDetectedIcon);
  if (activity === "assistant-speaking") return createElement(SpeakerIcon);
  return createElement(MicrophoneIcon, {
    active: activity === "connecting" || activity === "listening",
  });
}

function MicrophoneIcon({ active }: { readonly active: boolean }) {
  return createElement(
    "svg",
    {
      "aria-hidden": true,
      fill: "none",
      height: 16,
      viewBox: "0 0 24 24",
      width: 16,
    },
    createElement("path", {
      d: "M12 3.75a3 3 0 0 0-3 3v4.5a3 3 0 1 0 6 0v-4.5a3 3 0 0 0-3-3Z",
      stroke: "currentColor",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      strokeWidth: 1.8,
    }),
    createElement("path", {
      d: "M5.75 10.75a6.25 6.25 0 0 0 12.5 0M12 17v3.25M8.75 20.25h6.5",
      stroke: "currentColor",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      strokeWidth: 1.8,
    }),
    active ? createElement("circle", { cx: 18.25, cy: 5.75, fill: "currentColor", r: 1.75 }) : null,
  );
}

function SpeechDetectedIcon() {
  return createElement(
    "svg",
    {
      "aria-hidden": true,
      fill: "none",
      height: 16,
      viewBox: "0 0 24 24",
      width: 16,
    },
    createElement("path", {
      d: "M4.75 13.25v-2.5M8.25 16.5v-9M11.75 19v-14M15.25 16.5v-9M18.75 13.25v-2.5",
      stroke: "currentColor",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      strokeWidth: 1.8,
    }),
  );
}

function SpeakerIcon() {
  return createElement(
    "svg",
    {
      "aria-hidden": true,
      fill: "none",
      height: 16,
      viewBox: "0 0 24 24",
      width: 16,
    },
    createElement("path", {
      d: "M5 14.25h3.25L13 18V6L8.25 9.75H5v4.5Z",
      stroke: "currentColor",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      strokeWidth: 1.8,
    }),
    createElement("path", {
      d: "M16.25 9.25a4 4 0 0 1 0 5.5M18.75 7a7.5 7.5 0 0 1 0 10",
      stroke: "currentColor",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      strokeWidth: 1.8,
    }),
  );
}

function resolveActivity(input: {
  readonly isPlaying: boolean;
  readonly isUserSpeaking: boolean;
  readonly status: Experimental_RealtimeStatus;
}): EveVoiceActivity {
  if (input.status === "error") return "error";
  if (input.status === "connecting") return "connecting";
  if (input.status !== "connected") return "ready";
  if (input.isUserSpeaking) return "user-speaking";
  if (input.isPlaying) return "assistant-speaking";
  return "listening";
}

function voiceButtonLabel(activity: EveVoiceActivity): string {
  switch (activity) {
    case "assistant-speaking":
      return "Stop voice; assistant is speaking";
    case "connecting":
      return "Connecting voice";
    case "error":
      return "Voice unavailable";
    case "listening":
      return "Stop voice; listening";
    case "user-speaking":
      return "Stop voice; speech detected";
    case "ready":
      return "Start voice";
  }
}

function buildSessionConfig(input: {
  readonly sessionConfig: Partial<Experimental_RealtimeSessionConfig> | undefined;
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
