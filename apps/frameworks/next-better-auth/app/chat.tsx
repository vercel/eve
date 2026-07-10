"use client";

import { useEveAgent } from "eve/react";
import { type FormEvent, useState } from "react";

export function Chat() {
  const agent = useEveAgent();
  const [message, setMessage] = useState("Who am I?");
  const isBusy = agent.status === "submitted" || agent.status === "streaming";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = message.trim();
    if (value.length === 0 || isBusy) {
      return;
    }

    setMessage("");
    await agent.send({ message: value });
  }

  return (
    <section className="chat-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">eve session</p>
          <h2>Authenticated agent</h2>
        </div>
        <span className="status">{agent.status}</span>
      </div>
      <div className="messages">
        {agent.data.messages.length === 0 ? (
          <p className="empty-message">
            Ask the agent who you are. Its <code>whoami</code> tool reads the Better Auth principal
            attached by the eve channel.
          </p>
        ) : (
          agent.data.messages.map((entry) => (
            <pre key={entry.id}>{JSON.stringify(entry, null, 2)}</pre>
          ))
        )}
      </div>
      {agent.error ? <p className="error-message">{agent.error.message}</p> : null}
      <form className="composer" onSubmit={submit}>
        <input
          aria-label="Message"
          disabled={isBusy}
          onChange={(event) => setMessage(event.target.value)}
          value={message}
        />
        <button className="primary-button" disabled={isBusy} type="submit">
          {isBusy ? "Sending…" : "Send"}
        </button>
      </form>
    </section>
  );
}
