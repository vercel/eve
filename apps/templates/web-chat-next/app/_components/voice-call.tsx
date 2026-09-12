"use client";

import { LoaderIcon, MicIcon, SquareIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

type VoiceStatus = "connecting" | "idle" | "listening" | "thinking" | "speaking" | "error";

interface TranscriptEntry {
  readonly role: "user" | "assistant";
  readonly text: string;
}

const AUDIO_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  opus: "audio/ogg",
  ogg: "audio/ogg",
};

const STATUS_LABEL: Record<VoiceStatus, string> = {
  connecting: "Connecting…",
  idle: "Hold to talk",
  listening: "Listening…",
  thinking: "Thinking…",
  speaking: "Speaking…",
  error: "Disconnected",
};

/**
 * Push-to-talk voice client for the eve `voiceChannel`. Hold the button to
 * record one utterance; releasing sends it. The agent's spoken reply streams
 * back sentence by sentence and plays automatically. Talking again interrupts
 * playback (barge-in).
 */
export function VoiceCall({ wsUrl }: { readonly wsUrl?: string }) {
  const [status, setStatus] = useState<VoiceStatus>("connecting");
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioFormatRef = useRef("mp3");
  const playQueueRef = useRef<Blob[]>([]);
  const playingRef = useRef(false);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);

  const resolveUrl = useCallback((): string => {
    if (wsUrl) return wsUrl;
    const url = new URL("/eve/v1/voice", window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }, [wsUrl]);

  const stopPlayback = useCallback(() => {
    playQueueRef.current = [];
    playingRef.current = false;
    const audio = currentAudioRef.current;
    if (audio) {
      audio.pause();
      audio.src = "";
      currentAudioRef.current = null;
    }
  }, []);

  const playNext = useCallback(() => {
    if (playingRef.current) return;
    const next = playQueueRef.current.shift();
    if (!next) return;
    playingRef.current = true;
    const audio = new Audio(URL.createObjectURL(next));
    currentAudioRef.current = audio;
    const advance = () => {
      URL.revokeObjectURL(audio.src);
      playingRef.current = false;
      currentAudioRef.current = null;
      playNext();
    };
    audio.onended = advance;
    audio.onerror = advance;
    void audio.play().catch(advance);
  }, []);

  const appendAssistantText = useCallback((text: string) => {
    setTranscript((entries) => {
      const last = entries[entries.length - 1];
      if (last?.role === "assistant") {
        const merged = [...entries];
        merged[merged.length - 1] = { role: "assistant", text: `${last.text} ${text}`.trim() };
        return merged;
      }
      return [...entries, { role: "assistant", text }];
    });
  }, []);

  const handleControl = useCallback(
    (raw: string) => {
      let message: { type?: string; [key: string]: unknown };
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }
      switch (message.type) {
        case "ready":
          if (typeof message.audioFormat === "string") audioFormatRef.current = message.audioFormat;
          setStatus("idle");
          break;
        case "user_transcript":
          if (typeof message.text === "string" && message.text.length > 0) {
            setTranscript((entries) => [
              ...entries,
              { role: "user", text: message.text as string },
            ]);
          }
          break;
        case "assistant_text":
          if (typeof message.text === "string") appendAssistantText(message.text);
          break;
        case "status":
          if (message.state === "thinking" || message.state === "speaking") {
            setStatus(message.state);
          } else if (message.state === "idle") {
            setStatus((current) => (current === "listening" ? current : "idle"));
          }
          break;
        case "error":
          if (typeof message.message === "string") setError(message.message);
          break;
        default:
          break;
      }
    },
    [appendAssistantText],
  );

  useEffect(() => {
    const ws = new WebSocket(resolveUrl());
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => setStatus("idle");
    ws.onerror = () => {
      setStatus("error");
      setError("Could not reach the voice channel.");
    };
    ws.onclose = () => setStatus("error");
    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        handleControl(event.data);
        return;
      }
      const mime = AUDIO_MIME[audioFormatRef.current] ?? "audio/mpeg";
      playQueueRef.current.push(new Blob([event.data as ArrayBuffer], { type: mime }));
      playNext();
    };

    return () => {
      ws.close();
      stopPlayback();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, [resolveUrl, handleControl, playNext, stopPlayback]);

  const startRecording = useCallback(async () => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (status === "listening") return;

    // Talking interrupts whatever the agent is currently saying.
    stopPlayback();
    ws.send(JSON.stringify({ type: "barge_in" }));

    try {
      let stream = streamRef.current;
      if (!stream) {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;
      }
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
        chunksRef.current = [];
        if (blob.size === 0) return;
        const buffer = await blob.arrayBuffer();
        if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(buffer);
      };
      recorderRef.current = recorder;
      recorder.start();
      setStatus("listening");
    } catch {
      setError("Microphone access was denied.");
      setStatus("idle");
    }
  }, [status, stopPlayback]);

  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }
    recorderRef.current = null;
    setStatus((current) => (current === "listening" ? "thinking" : current));
  }, []);

  const isBusy = status === "thinking" || status === "speaking";

  return (
    <main className="flex h-dvh flex-col bg-background text-foreground">
      <header className="flex h-14 shrink-0 items-center justify-center border-b">
        <span className="text-muted-foreground text-sm">Voice · eve agent</span>
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {transcript.length === 0 ? (
          <p className="mt-8 text-center text-muted-foreground text-sm">
            Hold the microphone button and speak to your agent.
          </p>
        ) : (
          transcript.map((entry, index) => (
            <div
              key={index}
              className={cn("flex", entry.role === "user" ? "justify-end" : "justify-start")}
            >
              <span
                className={cn(
                  "max-w-[80%] rounded-2xl px-4 py-2 text-sm",
                  entry.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted",
                )}
              >
                {entry.text}
              </span>
            </div>
          ))
        )}
      </div>

      {error ? <p className="px-4 pb-2 text-center text-destructive text-xs">{error}</p> : null}

      <footer className="flex flex-col items-center gap-2 border-t p-6">
        <button
          type="button"
          disabled={status === "connecting" || status === "error"}
          onPointerDown={() => void startRecording()}
          onPointerUp={stopRecording}
          onPointerLeave={stopRecording}
          className={cn(
            "flex size-20 items-center justify-center rounded-full text-primary-foreground transition-colors disabled:opacity-50",
            status === "listening" ? "bg-destructive" : "bg-primary",
          )}
          aria-label="Hold to talk"
        >
          {isBusy ? (
            <LoaderIcon className="size-8 animate-spin" />
          ) : status === "listening" ? (
            <SquareIcon className="size-7" />
          ) : (
            <MicIcon className="size-8" />
          )}
        </button>
        <span className="text-muted-foreground text-sm">{STATUS_LABEL[status]}</span>
      </footer>
    </main>
  );
}
