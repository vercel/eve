"use client";

import {
  createOpenAI,
  type Experimental_OpenAIRealtimeModelLiveOptions as OpenAIRealtimeModelLiveOptions,
} from "@ai-sdk/openai";
import { experimental_useRealtime as useRealtime } from "@ai-sdk/react";
import type { Experimental_RealtimeServerEvent as RealtimeServerEvent } from "ai";
import { Client, type InputRequest } from "eve/client";
import { LoaderCircleIcon, MicIcon, MicOffIcon, PhoneIcon, PhoneOffIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  LIVE_INSTRUCTIONS,
  LIVE_MODEL,
  LIVE_WEBSOCKET_URL,
  MAX_CALL_SECONDS,
} from "@/lib/voice-config";
import { type Delegation, VoiceDelegate } from "@/lib/voice-delegate";
import { cn } from "@/lib/utils";

// The browser only uses the provider as the Live protocol codec. The single-use
// client secret travels as a WebSocket subprotocol, so no API key ships here.
const model = createOpenAI({
  apiKey: "unused",
  baseURL: "https://ai-gateway.vercel.sh/v1",
}).experimental_realtime(LIVE_MODEL, { api: "live" });

const sessionConfig = {
  instructions: LIVE_INSTRUCTIONS,
  providerOptions: {
    openai: {
      delegation: { type: "client" },
      store: false,
    } satisfies OpenAIRealtimeModelLiveOptions,
  },
};

// Gives trailing transcript words a moment to arrive after a delegation starts.
const TRANSCRIPT_SETTLE_MS = 300;

type Turn = { speaker: "user" | "assistant"; text: string };

export function VoiceCall() {
  const [protocols, setProtocols] = useState<string[] | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [delegations, setDelegations] = useState<readonly Delegation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const turnsRef = useRef<Turn[]>([]);
  const delegatedTurnsRef = useRef(0);
  const delegateRef = useRef<VoiceDelegate | null>(null);

  const rt = useRealtime({
    api: { protocols: protocols ?? [], websocket: LIVE_WEBSOCKET_URL },
    model,
    onError: (event) => setError(event.message),
    onEvent: (event) => handleEvent(event),
    sessionConfig,
  });

  const { close, connect, sendEvent } = rt;
  const active = rt.status === "connecting" || rt.status === "connected";

  const endCall = useCallback(async () => {
    const delegate = delegateRef.current;
    delegateRef.current = null;
    await Promise.allSettled([delegate?.dispose(), close()]);
    setProtocols(null);
  }, [close]);

  // Each client secret is single use, so a new token rebuilds the hook's session
  // and the call connects once that render commits.
  useEffect(() => {
    if (!protocols) return;
    setStarting(false);
    connect().catch((cause: unknown) => setError(String(cause)));
  }, [protocols, connect]);

  useEffect(() => {
    if (rt.status !== "connected") return;
    const timer = setTimeout(() => void endCall(), MAX_CALL_SECONDS * 1000);
    return () => clearTimeout(timer);
  }, [rt.status, endCall]);

  useEffect(() => () => void delegateRef.current?.dispose(), []);

  async function startCall() {
    setError(null);
    setStarting(true);
    setTurns((turnsRef.current = []));
    setDelegations([]);
    delegatedTurnsRef.current = 0;
    delegateRef.current = new VoiceDelegate({
      appendContext: (delegationId, channel, content) =>
        sendEvent({
          content,
          delegationId,
          providerOptions: { openai: { channel } },
          type: "context-append",
        }),
      client: new Client({ host: "" }),
      onChange: setDelegations,
    });

    const response = await fetch("/api/live/client-secret", { method: "POST" });
    const body = (await response.json().catch(() => ({}))) as {
      readonly error?: string;
      readonly token?: string;
    };

    if (!response.ok || !body.token) {
      setError(body.error ?? "Could not start a voice session.");
      setStarting(false);
      return;
    }

    setProtocols(["ai-gateway-realtime.v1", `ai-gateway-auth.${body.token}`]);
  }

  function handleEvent(event: RealtimeServerEvent) {
    switch (event.type) {
      case "transcript-fragment":
        appendTranscript(event.speaker, event.delta);
        return;
      case "delegation-created":
        setTimeout(() => {
          delegateRef.current?.delegate(event.delegationId, takeUserRequest());
        }, TRANSCRIPT_SETTLE_MS);
        return;
      case "session-closed":
        void endCall();
        return;
    }
  }

  function appendTranscript(speaker: Turn["speaker"], delta: string) {
    const current = turnsRef.current;
    const last = current.at(-1);
    turnsRef.current =
      last?.speaker === speaker
        ? [...current.slice(0, -1), { speaker, text: last.text + delta }]
        : [...current, { speaker, text: delta.trimStart() }];
    setTurns(turnsRef.current);
  }

  /** Everything the user said since the previous delegation. */
  function takeUserRequest(): string {
    const current = turnsRef.current;
    const pending = current.slice(delegatedTurnsRef.current).filter((t) => t.speaker === "user");
    delegatedTurnsRef.current = current.length;
    const request = pending.map((turn) => turn.text.trim()).join(" ");
    return request || (current.findLast((turn) => turn.speaker === "user")?.text.trim() ?? "");
  }

  const muted = rt.session?.isInputMuted ?? false;

  return (
    <div className="flex w-full max-w-2xl flex-col gap-6">
      <div className="flex items-center justify-center gap-3">
        {active ? (
          <>
            <button
              aria-label={muted ? "Unmute microphone" : "Mute microphone"}
              className="flex size-12 items-center justify-center rounded-full border border-border bg-card"
              onClick={() =>
                void sendEvent({ type: muted ? "input-audio-unmute" : "input-audio-mute" })
              }
              type="button"
            >
              {muted ? <MicOffIcon className="size-5" /> : <MicIcon className="size-5" />}
            </button>
            <button
              className="flex h-12 items-center gap-2 rounded-full bg-destructive px-6 font-medium text-white"
              onClick={() => void endCall()}
              type="button"
            >
              <PhoneOffIcon className="size-4" />
              End call
            </button>
          </>
        ) : (
          <button
            className="flex h-12 items-center gap-2 rounded-full bg-primary px-6 font-medium text-primary-foreground disabled:opacity-60"
            disabled={starting}
            onClick={() => void startCall()}
            type="button"
          >
            {starting ? (
              <LoaderCircleIcon className="size-4 animate-spin" />
            ) : (
              <PhoneIcon className="size-4" />
            )}
            Start call
          </button>
        )}
      </div>

      <p className="text-center text-sm text-muted-foreground">
        {rt.status === "connected"
          ? "On call. Talk naturally; you can interrupt at any time."
          : rt.status === "connecting"
            ? "Connecting…"
            : "Calls end automatically after 10 minutes."}
      </p>

      {error ? (
        <p className="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {delegations
        .filter((delegation) => delegation.status === "needs-input")
        .map((delegation) => (
          <InputPrompt
            delegation={delegation}
            key={delegation.id}
            onRespond={(responses) => delegateRef.current?.respond(delegation.id, responses)}
          />
        ))}

      <section className="flex flex-col gap-2">
        {turns.map((turn, index) => (
          <p
            className={cn(
              "max-w-[85%] rounded-lg px-3 py-2 text-sm",
              turn.speaker === "user" ? "self-end bg-primary text-primary-foreground" : "bg-card",
            )}
            key={index}
          >
            {turn.text}
          </p>
        ))}
      </section>

      {delegations.length > 0 ? (
        <section className="flex flex-col gap-2 border-t border-border pt-4">
          <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            eve agent activity
          </h2>
          {delegations.map((delegation) => (
            <div className="rounded-md bg-card px-3 py-2 text-sm" key={delegation.id}>
              <p className="font-medium">{delegation.request || "(no transcript)"}</p>
              {delegation.steps.map((step, index) => (
                <p className="text-muted-foreground" key={index}>
                  {step}
                </p>
              ))}
              <p className="text-muted-foreground">
                {delegation.status === "done"
                  ? delegation.answer
                  : delegation.status === "failed"
                    ? "Failed"
                    : delegation.status === "needs-input"
                      ? "Waiting for you"
                      : "Working…"}
              </p>
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}

function InputPrompt({
  delegation,
  onRespond,
}: {
  readonly delegation: Delegation;
  readonly onRespond: (responses: { requestId: string; optionId: string }[]) => void;
}) {
  const requests: readonly InputRequest[] = delegation.inputRequests ?? [];

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      {requests.map((request) => (
        <div className="flex flex-col gap-3" key={request.requestId}>
          <p className="text-sm font-medium">{request.prompt}</p>
          <div className="flex gap-2">
            {(request.options ?? []).map((option) => (
              <button
                className={cn(
                  "rounded-md border border-border px-3 py-1.5 text-sm",
                  option.style === "primary" && "bg-primary text-primary-foreground",
                  option.style === "danger" && "text-destructive",
                )}
                key={option.id}
                onClick={() => onRespond([{ optionId: option.id, requestId: request.requestId }])}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
