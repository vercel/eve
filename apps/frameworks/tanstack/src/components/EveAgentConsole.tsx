import { useEveAgent, type EveDynamicToolPart, type EveMessagePart } from "eve/react";
import { useState } from "react";

function ToolBlock({
  canRespond,
  onRespond,
  part,
}: Readonly<{
  canRespond: boolean;
  onRespond: (requestId: string, optionId: string) => void;
  part: EveDynamicToolPart;
}>) {
  const inputRequest = part.toolMetadata?.eve?.inputRequest;
  const awaitingResponse =
    inputRequest !== undefined && part.toolMetadata?.eve?.inputResponse === undefined;

  return (
    <div className="tool">
      <strong>{part.toolMetadata?.eve?.name ?? part.toolName}</strong> <em>{part.state}</em>
      <pre>{JSON.stringify(part.input, null, 2)}</pre>
      {part.output !== undefined ? <pre>{JSON.stringify(part.output, null, 2)}</pre> : null}
      {part.errorText ? <p className="error">{part.errorText}</p> : null}
      {awaitingResponse ? (
        <div>
          <p>{inputRequest.prompt}</p>
          {(inputRequest.options ?? []).map((option) => (
            <button
              disabled={!canRespond}
              key={option.id}
              onClick={() => onRespond(inputRequest.requestId, option.id)}
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
    case "dynamic-tool":
      return <ToolBlock canRespond={canRespond} onRespond={onRespond} part={part} />;
    default:
      return null;
  }
}

export function EveAgentConsole() {
  const agent = useEveAgent();
  const [draft, setDraft] = useState("");
  const isBusy = agent.status === "submitted" || agent.status === "streaming";
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

      {agent.data.messages.length === 0 ? (
        <p>Ask for the weather in Vienna, or tell the agent to explain the tools it called.</p>
      ) : (
        <div className="messages">
          {agent.data.messages.map((message) => (
            <div className="message" data-role={message.role} key={message.id}>
              {message.parts.map((part, index) => (
                <PartView
                  canRespond={!isInputDisabled}
                  key={part.type === "dynamic-tool" ? part.toolCallId : `${part.type}:${index}`}
                  onRespond={(requestId, optionId) => void agent.respond([{ optionId, requestId }])}
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
        {isBusy ? (
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
