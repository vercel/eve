"use client";

import { useEveAgent } from "eve/react";
import { type FormEvent, type JSX, useEffect, useMemo, useRef, useState } from "react";

import { traceReducer } from "./trace-reducer";
import { resolveTurnFailureMessage, shouldRenderAssistantTurn } from "./turn-content";
import type { TraceTurn } from "./types";

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

export function App() {
  const [composerInput, setComposerInput] = useState("");
  const [composerError, setComposerError] = useState<string | undefined>(undefined);
  const conversationStageRef = useRef<HTMLElement | null>(null);
  const reducer = useMemo(() => traceReducer(), []);
  const agent = useEveAgent({
    reducer,
  });

  const turns = agent.data.turns;
  const isComposeInProgress = agent.status === "submitted" || agent.status === "streaming";
  const hasComposerText = composerInput.trim().length > 0;
  const hasConversation = turns.length > 0 || isComposeInProgress;
  const conversationActivityKey = [
    agent.session.sessionId ?? "new-thread",
    String(agent.session.streamIndex),
    String(agent.events.length),
    agent.status,
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
        <div className="composer-actions">
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
              <ConversationSection
                isSending={agent.status === "submitted" || agent.status === "streaming"}
                turns={turns}
              />
            </div>
          ) : (
            <div className="empty-state">
              <h1 className="wordmark">eve Agent</h1>
              {composerForm}
            </div>
          )}
        </section>

        {hasConversation ? composerForm : null}
      </main>
    </div>
  );
}
