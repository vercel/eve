"use client";

import {
  createOpenAI,
  type Experimental_OpenAIRealtimeModelLiveOptions as OpenAIRealtimeModelLiveOptions,
} from "@ai-sdk/openai";
import { experimental_useRealtime as useRealtime } from "@ai-sdk/react";
import type { Experimental_RealtimeServerEvent as RealtimeServerEvent } from "ai";
import { useEveAgent } from "eve/react";
import { LoaderCircleIcon, MicIcon, MicOffIcon, PhoneIcon, PhoneOffIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AgentMessage } from "@/app/_components/agent-message";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Button } from "@/components/ui/button";
import {
  LIVE_INSTRUCTIONS,
  LIVE_MODEL,
  LIVE_WEBSOCKET_URL,
  MAX_CALL_SECONDS,
} from "@/lib/voice-config";
import { VoiceDelegate } from "@/lib/voice-delegate";

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
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  // The spoken transcript only feeds delegations; the page renders the eve session.
  const turnsRef = useRef<Turn[]>([]);
  const delegatedTurnsRef = useRef(0);
  const delegateRef = useRef<VoiceDelegate | null>(null);

  const agent = useEveAgent({
    onError: () => delegateRef.current?.fail(),
    onEvent: (event) => delegateRef.current?.observe(event),
    onFinish: () => delegateRef.current?.settled(),
  });

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
    // One call is one eve session.
    agent.reset();
    turnsRef.current = [];
    delegatedTurnsRef.current = 0;
    delegateRef.current = new VoiceDelegate({
      agent: { cancel: agent.cancel, respond: agent.respond, send: agent.send },
      appendContext: (delegationId, channel, content) =>
        sendEvent({
          content,
          delegationId,
          providerOptions: { openai: { channel } },
          type: "context-append",
        }),
    });

    const response = await fetch("/api/live/client-secret", { method: "POST" }).catch(() => null);
    const body = ((await response?.json().catch(() => null)) ?? {}) as {
      readonly error?: string;
      readonly token?: string;
    };

    if (!response?.ok || !body.token) {
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
  // Same input wiring as the Web Chat registry's agent-chat.
  const canRespond = (requestId: string) => agent.data.inputs[requestId]?.status === "open";
  const questionsFor = (callId: string) =>
    Object.values(agent.data.inputs).filter(
      (input) => input.request.kind === "question" && input.request.action.callId === callId,
    );

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="mx-auto w-full max-w-3xl gap-6 px-4 pt-6 pb-10 sm:px-6">
          {agent.data.messages.map((message, index) => (
            <AgentMessage
              canRespond={canRespond}
              isStreaming={agent.status === "streaming" && index === agent.data.messages.length - 1}
              key={message.id}
              message={message}
              onInputResponses={(responses) => agent.respond(responses)}
              questionsFor={questionsFor}
            />
          ))}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-3 px-4 pt-4 pb-6">
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <div className="flex items-center gap-3">
          {active ? (
            <>
              <Button
                aria-label={muted ? "Unmute microphone" : "Mute microphone"}
                onClick={() =>
                  void sendEvent({ type: muted ? "input-audio-unmute" : "input-audio-mute" })
                }
                size="icon-lg"
                variant="outline"
              >
                {muted ? <MicOffIcon /> : <MicIcon />}
              </Button>
              <Button onClick={() => void endCall()} size="lg" variant="destructive">
                <PhoneOffIcon />
                End call
              </Button>
            </>
          ) : (
            <Button disabled={starting} onClick={() => void startCall()} size="lg">
              {starting ? <LoaderCircleIcon className="animate-spin" /> : <PhoneIcon />}
              Start call
            </Button>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          {rt.status === "connected"
            ? "On call. Talk naturally; you can interrupt at any time."
            : rt.status === "connecting"
              ? "Connecting…"
              : "Calls end automatically after 10 minutes."}
        </p>
      </div>
    </div>
  );
}
