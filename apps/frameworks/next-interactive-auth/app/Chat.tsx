"use client";

import { useEveAgent, type EveMessagePart } from "eve/react";
import { useEffect, useRef, useState, type FormEvent } from "react";

function AuthorizationPrompt({ part }: { readonly part: EveMessagePart }) {
  if (part.type !== "authorization") return null;

  if (part.state === "completed") {
    return (
      <p className="authorization-status">
        {part.outcome === "authorized"
          ? "Sign-in completed. Continuing your message…"
          : `Sign-in ${part.outcome}.`}
      </p>
    );
  }

  return (
    <section className="authorization-card">
      <strong>{part.displayName}</strong>
      <p>{part.description}</p>
      {part.authorization?.userCode ? <code>{part.authorization.userCode}</code> : null}
      {part.authorization?.url ? (
        <a href={part.authorization.url} rel="noreferrer" target="_blank">
          Sign in to continue
        </a>
      ) : null}
    </section>
  );
}

export function Chat() {
  const agent = useEveAgent();
  const [message, setMessage] = useState("");
  const feedRef = useRef<HTMLDivElement | null>(null);
  const isBusy = agent.status === "submitted" || agent.status === "streaming";
  const isResuming = agent.status === "resuming";

  useEffect(() => {
    const feed = feedRef.current;
    if (feed === null) return;
    feed.scrollTo({ behavior: "smooth", top: feed.scrollHeight });
  }, [agent.data.messages, agent.status]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = message.trim();
    if (trimmed.length === 0 || isBusy || isResuming) return;
    setMessage("");
    await agent.send(trimmed);
  }

  return (
    <main className="chat-page">
      <header className="chat-header">
        <span>eve</span>
        <button onClick={() => agent.reset()} type="button">
          New chat
        </button>
      </header>

      <div className="message-feed" ref={feedRef}>
        {agent.data.messages.length === 0 ? (
          <section className="empty-state">
            <h1>How can I help?</h1>
            <p>Send a message to start a conversation.</p>
          </section>
        ) : (
          <div className="message-list">
            {agent.data.messages.map((item) => (
              <article className={`message message-${item.role}`} key={item.id}>
                <div className="message-content">
                  {item.parts.map((part, index) => {
                    if (part.type === "text") {
                      return <p key={index}>{part.text}</p>;
                    }
                    if (part.type === "authorization") {
                      return <AuthorizationPrompt key={index} part={part} />;
                    }
                    return null;
                  })}
                </div>
              </article>
            ))}
            {agent.status === "submitted" ? (
              <article className="message message-assistant">
                <div className="message-content pending">Thinking…</div>
              </article>
            ) : null}
          </div>
        )}
      </div>

      <form className="composer" onSubmit={submit}>
        <label className="visually-hidden" htmlFor="message">
          Message
        </label>
        <textarea
          disabled={isBusy || isResuming}
          id="message"
          onChange={(event) => setMessage(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder="Message eve…"
          rows={1}
          value={message}
        />
        <button
          aria-label="Send message"
          disabled={isBusy || isResuming || message.trim().length === 0}
          type="submit"
        >
          ↑
        </button>
        {agent.error !== undefined ? <p className="composer-error">{agent.error.message}</p> : null}
      </form>
    </main>
  );
}
