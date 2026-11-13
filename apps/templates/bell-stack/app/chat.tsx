"use client";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEveAgent } from "eve/react";
import { Client } from "eve/client";
import { useState } from "react";
import { browserPreview } from "./projection";

export default function Chat({ sessionId, demoUrl }: { sessionId?: string; demoUrl: string }) {
  const router = useRouter();
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [retiring, setRetiring] = useState(false);
  const agent = useEveAgent({
    initialSession: sessionId ? { sessionId, streamIndex: 0 } : undefined,
    resume: Boolean(sessionId),
    onSessionChange(session) {
      if (session && !sessionId)
        window.history.replaceState(null, "", `/s/${encodeURIComponent(session.sessionId)}`);
    },
  });
  const busy = agent.status === "submitted" || agent.status === "streaming";
  const waiting = busy || agent.status === "resuming" || retiring;
  const preview = browserPreview(agent.events);
  const pending = agent.data.messages
    .flatMap((message) => message.parts)
    .flatMap((part) => {
      if (part.type !== "dynamic-tool" || part.state !== "approval-requested") return [];
      const request = part.toolMetadata?.eve?.inputRequest;
      return request ? [request] : [];
    });
  async function send(text: string) {
    if (!text.trim() || waiting) return;
    setError("");
    setInput("");
    try {
      await agent.send(text.trim());
    } catch {
      setError("The request failed. Check the local server and retry.");
    }
  }
  async function newConversation() {
    if (waiting) return;
    setRetiring(true);
    setError("");
    try {
      if (agent.session)
        await new Client({ host: "" }).sessions.attach(agent.session.sessionId).reset();
      agent.reset();
      setInput("");
      router.push("/");
    } catch {
      setError("Could not close this conversation. Please retry.");
    } finally {
      setRetiring(false);
    }
  }
  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">PERSONAL ASSISTANT STACK</p>
          <h1>
            Bell<span>.</span>
          </h1>
        </div>
        <button
          className="new-chat"
          disabled={waiting}
          onClick={() => void newConversation()}
        >
          New conversation
        </button>
      </header>
      <section className="workspace">
        <div className="conversation">
          <h2>Ask. Browse. Verify.</h2>
          <p className="muted">One conversation, one persistent browser.</p>
          <button
            className="starter"
            disabled={waiting}
            onClick={() =>
              void send(
                `Open ${demoUrl} with run, describe what the page shows, then take a screenshot.`,
              )
            }
          >
            Open demo site ↗
          </button>
          <div className="messages" aria-live="polite">
            {agent.data.messages
              .filter((message) => message.role === "user" || message.role === "assistant")
              .map((message) => (
                <article key={message.id} className={message.role}>
                  <strong>{message.role === "user" ? "You" : "Bell"}</strong>
                  {message.parts.map((part, index) =>
                    part.type === "text" ? <p key={index}>{part.text}</p> : null,
                  )}
                </article>
              ))}
          </div>
          <p role="status" className="muted">
            {waiting ? "Working…" : "Ready"}
          </p>
          {(error || agent.error) && (
            <p role="alert">
              {error || "The agent request failed. Check server configuration and retry."}
            </p>
          )}
          {pending.map((request) => (
            <fieldset key={request.requestId}>
              <legend>{request.prompt}</legend>
              {request.options?.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() =>
                    void agent
                      .respond([{ requestId: request.requestId, optionId: option.id }])
                      .catch(() => setError("Reply failed. Please retry."))
                  }
                >
                  {option.label}
                </button>
              ))}
              {request.allowFreeform && (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const text = String(
                      new FormData(event.currentTarget).get("reply") ?? "",
                    ).trim();
                    if (text)
                      void agent
                        .respond([{ requestId: request.requestId, text }])
                        .catch(() => setError("Reply failed. Please retry."));
                  }}
                >
                  <label htmlFor={`reply-${request.requestId}`}>Your reply</label>
                  <input id={`reply-${request.requestId}`} name="reply" required />
                  <button>Reply</button>
                </form>
              )}
            </fieldset>
          ))}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void send(input);
            }}
          >
            <label htmlFor="message">Message Bell</label>
            <textarea
              id="message"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="What would you like to do?"
              disabled={waiting}
            />
            <div className="actions">
              <button type="submit" disabled={waiting || !input.trim()}>
                Send
              </button>
              {busy && (
                <button
                  type="button"
                  onClick={() =>
                    void agent.cancel().catch(() => setError("Stop failed. Please retry."))
                  }
                >
                  Stop
                </button>
              )}
            </div>
          </form>
        </div>
        <aside>
          <div className="browser-bar">
            <span>Browser capture</span>
            <span>
              {preview.httpStatus
                ? `HTTP ${preview.httpStatus}`
                : preview.url
                  ? "Status unavailable"
                  : "Waiting"}
            </span>
          </div>
          <p className="address">{preview.url ?? "Your browser will appear here"}</p>
          {preview.screenshot ? (
            <Image
              src={preview.screenshot}
              width={1360}
              height={900}
              unoptimized
              alt="Latest browser screenshot"
            />
          ) : (
            <div className="empty">
              <span>✦</span>
              <p>See what Bell sees.</p>
              <small>Ask for a screenshot after a browser action.</small>
            </div>
          )}
          <p className="footnote">
            Screenshots update on request. This panel is a capture, not an interactive browser.
          </p>
        </aside>
      </section>
    </main>
  );
}
