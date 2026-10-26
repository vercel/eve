import { useEveAgent, type EveToolPart, type EveMessagePart } from "eve/react";
import { useState } from "react";
import { activeTurn } from "eve/events";

function ToolBlock({
  canRespond,
  onRespond,
  part,
}: Readonly<{
  canRespond: boolean;
  onRespond: (requestId: string, optionId: string) => void;
  part: EveToolPart;
}>) {
  const interaction = part.interaction;
  const inputRequest = interaction?.request;
  const awaitingResponse = interaction?.status === "open";

  return (
    <div className="tool">
      <strong>{part.label}</strong> <em>{part.state}</em>
      <pre>{JSON.stringify(part.input, null, 2)}</pre>
      {part.output !== undefined ? <pre>{JSON.stringify(part.output, null, 2)}</pre> : null}
      {part.error ? <p className="error">{part.error.message}</p> : null}
      {awaitingResponse && interaction !== undefined && inputRequest !== undefined ? (
        <div>
          <p>{inputRequest.prompt}</p>
          {(inputRequest.options ?? []).map((option) => (
            <button
              disabled={!canRespond}
              key={option.id}
              onClick={() => onRespond(interaction.interactionId, option.id)}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PartView({
  canRespond,
  onRespond,
  part,
}: Readonly<{
  canRespond: boolean;
  onRespond: (requestId: string, optionId: string) => void;
  part: EveMessagePart;
}>) {
  switch (part.type) {
    case "text":
      return <div>{part.text}</div>;
    case "reasoning":
      return <div className="reasoning">{part.text}</div>;
    case "tool":
      return <ToolBlock canRespond={canRespond} onRespond={onRespond} part={part} />;
    default:
      return null;
  }
}

export function EveAgentConsole() {
  const [draft, setDraft] = useState("");
  const agent = useEveAgent({ prewarm: draft.trim().length > 0 });
  const isBusy = agent.status === "busy";
  const turnOpen = activeTurn(agent.view) !== undefined;
  const isInputDisabled = isBusy || agent.status === "resuming";

  function submit() {
    const text = draft.trim();
    if (text.length === 0 || isInputDisabled) return;
    setDraft("");
    void agent.send(text);
  }

  return (
    <main>
      <header>
        <span>eve / agent</span>
        <span>{agent.status}</span>
      </header>

      {agent.error ? <p className="error">{agent.error.message}</p> : null}

      {agent.messages.length === 0 ? (
        <p>Ask for the weather in Vienna, or tell the agent to explain the tools it called.</p>
      ) : (
        <div className="messages">
          {agent.messages.map((message) => (
            <div className="message" data-role={message.role} key={message.id}>
              {message.parts.map((part, index) => (
                <PartView
                  canRespond={!isInputDisabled}
                  key={part.type === "tool" ? part.callId : `${part.type}:${index}`}
                  onRespond={(interactionId, optionId) =>
                    void agent.respond([{ interactionId, optionId }])
                  }
                  part={part}
                />
              ))}
            </div>
          ))}
        </div>
      )}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <textarea
          disabled={isInputDisabled}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder="Send a message..."
          rows={2}
          value={draft}
        />
        {turnOpen ? (
          <button onClick={() => void agent.cancel()} type="button">
            Stop
          </button>
        ) : (
          <button disabled={isInputDisabled || draft.trim().length === 0} type="submit">
            Send
          </button>
        )}
      </form>
    </main>
  );
}
