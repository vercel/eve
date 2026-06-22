"use client";

import { useEveAgent } from "eve/react";
import { useEveVoice, type EveVoiceMessage } from "eve/react/voice";
import { type FormEvent, type JSX, useEffect, useMemo, useRef, useState } from "react";

import { traceReducer, type TraceProjection } from "./trace-reducer";
import { resolveTurnFailureMessage, shouldRenderAssistantTurn } from "./turn-content";
import type { TraceTurn } from "./types";

// Demo session tracking sets are unbounded otherwise; cap them so a long
// voice session does not accumulate turn ids and spoken-message keys forever.
const MAX_TRACKED_VOICE_TURNS = 256;

function rememberBounded(seen: Set<string>, value: string, max: number): void {
  seen.add(value);
  while (seen.size > max) {
    const oldest = seen.values().next().value;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
}

function ConversationSection(props: {
  readonly isSending: boolean;
  readonly turns: readonly TraceTurn[];
}) {
  return (
    <ul className="chat-feed">
      {props.turns.flatMap((turn) => {
        const rendered: JSX.Element[] = [];

        if (typeof turn.userMessage === "string" && turn.userMessage.length > 0) {
          rendered.push(
            <li className="chat-row role-user" key={`${turn.turnId}:user`}>
              <div className="chat-bubble-stack">
                <div className="chat-bubble">{turn.userMessage}</div>
              </div>
            </li>,
          );
        }

        if (!shouldRenderAssistantTurn(turn)) {
          return rendered;
        }

        const assistantText = turn.assistantMessage ?? resolveTurnFailureMessage(turn) ?? "";
        rendered.push(
          <li
            className={`chat-row role-assistant${turn.status === "failed" ? " variant-error" : ""}`}
            key={`${turn.turnId}:assistant`}
          >
            <div className="chat-bubble-stack">
              <div className="chat-bubble">{assistantText}</div>
            </div>
          </li>,
        );

        return rendered;
      })}
      {props.isSending ? (
        <li className="chat-row role-assistant pending">
          <div className="chat-bubble">Thinking…</div>
        </li>
      ) : null}
    </ul>
  );
}

// In Gateway-control mode the durable turn runs server-side (its own `voice:`
// continuation), so the typed-chat feed (`agent.data.turns`) never sees it. The
// hook surfaces the live transcript (user finalized speech + the agent's
// streamed spoken words) as `voice.messages`; this feed renders it, with a
// Thinking… row in the gap while Eve runs the turn.
function VoiceConversationSection(props: {
  readonly messages: readonly EveVoiceMessage[];
  readonly thinking: boolean;
}) {
  return (
    <ul className="chat-feed">
      {props.messages.map((message) => (
        <li className={`chat-row role-${message.role}`} key={message.id}>
          <div className="chat-bubble-stack">
            <div className="chat-bubble">{message.text}</div>
          </div>
        </li>
      ))}
      {props.thinking ? (
        <li className="chat-row role-assistant pending">
          <div className="chat-bubble">Thinking…</div>
        </li>
      ) : null}
    </ul>
  );
}

export function App() {
  const [composerInput, setComposerInput] = useState("");
  const [composerError, setComposerError] = useState<string | undefined>(undefined);
  const [voiceCaption, setVoiceCaption] = useState<string | undefined>(undefined);
  const controlMode = process.env.NEXT_PUBLIC_EVE_VOICE_CONTROL === "1";
  const conversationStageRef = useRef<HTMLElement | null>(null);
  const agentRef = useRef<ReturnType<typeof useEveAgent<TraceProjection>> | undefined>(undefined);
  const pendingVoiceMessagesRef = useRef<string[]>([]);
  const reducer = useMemo(() => traceReducer(), []);
  const spokenVoiceMessageKeysRef = useRef(new Set<string>());
  const voiceRef = useRef<Pick<ReturnType<typeof useEveVoice>, "speak"> | undefined>(undefined);
  const voiceTurnIdsRef = useRef(new Set<string>());
  const agent = useEveAgent({
    onEvent(event) {
      if (event.type === "message.received") {
        // Correlate by matching the transcript anywhere in the pending queue so
        // interleaved typed messages cannot shift the wrong entry off the head.
        const pendingIndex = pendingVoiceMessagesRef.current.indexOf(event.data.message);
        if (pendingIndex !== -1) {
          pendingVoiceMessagesRef.current.splice(pendingIndex, 1);
          rememberBounded(voiceTurnIdsRef.current, event.data.turnId, MAX_TRACKED_VOICE_TURNS);
          return;
        }
      }

      if (
        event.type === "message.completed" &&
        event.data.finishReason !== "tool-calls" &&
        event.data.message !== null &&
        voiceTurnIdsRef.current.has(event.data.turnId)
      ) {
        const key = `${event.data.turnId}:${event.data.stepIndex}:${event.data.message}`;
        if (spokenVoiceMessageKeysRef.current.has(key)) return;

        rememberBounded(spokenVoiceMessageKeysRef.current, key, MAX_TRACKED_VOICE_TURNS);
        voiceRef.current?.speak(event.data.message);
        setVoiceCaption(`Reply ready: ${event.data.message}`);
      }
    },
    reducer,
  });
  agentRef.current = agent;
  const voice = useEveVoice({
    // Opt into Gateway-owned control mode (A-lite): the Gateway drives turns
    // over its server-side control socket, so the browser only streams audio
    // and `onTranscript` below is not used. Defaults off (client-driven path).
    controlMode,
    onEvent(event) {
      // The live transcript now comes from `voice.messages` / `voice.isThinking`
      // (rendered by VoiceConversationSection). Only the client-driven path
      // keeps the lightweight caption.
      if (!controlMode && event.type === "input-transcription-completed") {
        setVoiceCaption(`Heard: ${event.transcript}`);
      }
    },
    async onTranscript({ transcript }) {
      setVoiceCaption(`Heard: ${transcript}`);
      pendingVoiceMessagesRef.current.push(transcript);
      try {
        await agentRef.current?.send({ message: transcript });
      } catch (error) {
        const index = pendingVoiceMessagesRef.current.indexOf(transcript);
        if (index !== -1) pendingVoiceMessagesRef.current.splice(index, 1);
        throw error;
      }
    },
  });
  voiceRef.current = voice;

  const turns = agent.data.turns;
  const isComposeInProgress = agent.status === "submitted" || agent.status === "streaming";
  const hasComposerText = composerInput.trim().length > 0;
  const hasVoiceConversation = controlMode && (voice.messages.length > 0 || voice.isThinking);
  const hasConversation = turns.length > 0 || isComposeInProgress || hasVoiceConversation;
  const conversationActivityKey = [
    agent.session.sessionId ?? "new-thread",
    String(agent.session.streamIndex),
    String(agent.events.length),
    agent.status,
    String(voice.messages.length),
    String(voice.messages.at(-1)?.text.length ?? 0),
    String(voice.isThinking),
  ].join(":");

  useEffect(() => {
    if (!hasConversation) {
      return;
    }

    const container = conversationStageRef.current;
    if (container === null) {
      return;
    }

    const frameId = requestAnimationFrame(() => {
      container.scrollTo({ top: container.scrollHeight });
    });

    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [conversationActivityKey, hasConversation]);

  const submitMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (isComposeInProgress) {
      return;
    }

    const message = composerInput.trim();
    if (message.length === 0) {
      setComposerError("Type a message before sending.");
      return;
    }

    setComposerError(undefined);
    setComposerInput("");
    if (agent.session.sessionId === undefined && agent.data.turns.length > 0) {
      agent.reset();
    }
    await agent.send({ message });
  };

  const isSendable = !isComposeInProgress && hasComposerText;

  const composerForm = (
    <form className="composer-shell" onSubmit={submitMessage}>
      <label className="visually-hidden" htmlFor="prompt-box">
        Message
      </label>
      <textarea
        id="prompt-box"
        onChange={(event) => {
          setComposerInput(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
        placeholder="Send a message..."
        rows={1}
        value={composerInput}
      />
      <div className="composer-footer">
        {voiceCaption !== undefined ? <p className="voice-caption">{voiceCaption}</p> : <span />}
        <div className="composer-actions">
          <button
            aria-label={voiceButtonLabel(voice.activity)}
            aria-pressed={voice.status === "connected" || voice.status === "connecting"}
            className="voice-toggle-button"
            data-status={voice.status}
            data-voice-state={voice.activity}
            disabled={voice.status === "connecting"}
            onClick={() => {
              if (voice.status === "connected" || voice.status === "connecting") {
                voice.stop();
                return;
              }
              void voice.start();
            }}
            title={voice.error?.message ?? voiceButtonLabel(voice.activity)}
            type="button"
          >
            <VoiceGlyph activity={voice.activity} />
          </button>
          <button
            className={`send-button${isSendable ? " ready" : ""}`}
            disabled={isComposeInProgress}
            type="submit"
          >
            ↑
          </button>
        </div>
      </div>
      {composerError !== undefined ? <p className="error-text">{composerError}</p> : null}
      {agent.error !== undefined ? <p className="error-text">{agent.error.message}</p> : null}
    </form>
  );

  return (
    <div className="page-shell">
      <main className={`main-stage chat-only${hasConversation ? " has-messages" : ""}`}>
        <section className="conversation-stage" ref={conversationStageRef}>
          {hasConversation ? (
            <div className="conversation-scroll">
              {controlMode ? (
                <VoiceConversationSection messages={voice.messages} thinking={voice.isThinking} />
              ) : (
                <ConversationSection
                  isSending={agent.status === "submitted" || agent.status === "streaming"}
                  turns={turns}
                />
              )}
            </div>
          ) : (
            <div className="empty-state">
              <h1 className="wordmark">eve Agent</h1>
            </div>
          )}
        </section>

        {composerForm}
      </main>
    </div>
  );
}

function VoiceGlyph(props: { readonly activity: ReturnType<typeof useEveVoice>["activity"] }) {
  if (props.activity === "assistant-speaking") {
    return (
      <svg aria-hidden="true" fill="none" height="16" viewBox="0 0 24 24" width="16">
        <path
          d="M5 14.25h3.25L13 18V6L8.25 9.75H5v4.5Z"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.8"
        />
        <path
          d="M16.25 9.25a4 4 0 0 1 0 5.5M18.75 7a7.5 7.5 0 0 1 0 10"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.8"
        />
      </svg>
    );
  }

  if (props.activity === "user-speaking") {
    return (
      <svg aria-hidden="true" fill="none" height="16" viewBox="0 0 24 24" width="16">
        <path
          d="M4.75 13.25v-2.5M8.25 16.5v-9M11.75 19v-14M15.25 16.5v-9M18.75 13.25v-2.5"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.8"
        />
      </svg>
    );
  }

  return (
    <svg aria-hidden="true" fill="none" height="16" viewBox="0 0 24 24" width="16">
      <path
        d="M12 3.75a3 3 0 0 0-3 3v4.5a3 3 0 1 0 6 0v-4.5a3 3 0 0 0-3-3Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="M5.75 10.75a6.25 6.25 0 0 0 12.5 0M12 17v3.25M8.75 20.25h6.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      {props.activity === "connecting" || props.activity === "listening" ? (
        <circle cx="18.25" cy="5.75" fill="currentColor" r="1.75" />
      ) : null}
    </svg>
  );
}

function voiceButtonLabel(activity: ReturnType<typeof useEveVoice>["activity"]): string {
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
  return "Start voice";
}
