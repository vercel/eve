"use client";

import type { ClientSessionState } from "eve/client";
import { openInteractions } from "eve/events";
import { useEveAgent } from "eve/react";
import { useEffect, useState } from "react";

type PageContext = Record<string, string>;

export function Assistant({ pageContext }: { pageContext: PageContext }) {
  // Read localStorage after mount, so the server and first client render match.
  const [saved, setSaved] = useState<ClientSessionState | null>();
  useEffect(() => {
    const raw = localStorage.getItem("assistant-session");
    setSaved(raw ? (JSON.parse(raw) as ClientSessionState) : null);
  }, []);
  if (saved === undefined) return null;
  return <Chat pageContext={pageContext} saved={saved ?? undefined} />;
}

function Chat({ pageContext, saved }: { pageContext: PageContext; saved?: ClientSessionState }) {
  const agent = useEveAgent({
    initialSession: saved,
    resume: saved !== undefined,
    // Reaches the model for this turn only; it isn't added to the conversation history.
    prepareSend: (input) => ({ ...input, clientContext: pageContext }),
  });
  useEffect(() => {
    if (agent.session) localStorage.setItem("assistant-session", JSON.stringify(agent.session));
  }, [agent.session]);

  const busy = agent.status === "busy";
  const prompts = openInteractions(agent.view).filter(
    (item) => item.request.kind !== "sign-in" && item.answer === undefined,
  );

  async function submit(form: HTMLFormElement) {
    const data = new FormData(form);
    const text = String(data.get("message") ?? "");
    const file = data.get("file");
    if (!(file instanceof File) || file.size === 0) return text && agent.send(text);
    const reader = new FileReader();
    const dataUrl = await new Promise<string>((resolve) => {
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(file);
    });
    return agent.send([
      { type: "text", text },
      { type: "file", data: dataUrl, mediaType: file.type, filename: file.name },
    ]);
  }

  return (
    <aside>
      {agent.messages.map((message) => (
        <p key={message.id}>
          {message.parts.map((part) => (part.type === "text" ? part.text : "")).join("")}
        </p>
      ))}
      {prompts.map(({ interactionId, request }) => (
        <div key={interactionId}>
          <p>{request.prompt}</p>
          {request.options?.map((option) => (
            <button
              key={option.id}
              onClick={() => void agent.respond([{ interactionId, optionId: option.id }])}
            >
              {option.label}
            </button>
          ))}
        </div>
      ))}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit(event.currentTarget);
        }}
      >
        <input name="message" disabled={agent.status === "resuming"} />
        <input name="file" type="file" accept="application/pdf" />
        <button type="submit">Send</button>
        {busy && (
          <button type="button" onClick={() => void agent.cancel()}>
            Stop
          </button>
        )}
      </form>
    </aside>
  );
}
