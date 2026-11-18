import { activeTurn } from "eve/events";
import { useEveAgent, type EveMessagePart, type EveToolPart } from "eve/solid";
import { createSignal, For, Match, Show, Switch } from "solid-js";

import "./styles.css";

function ToolBlock(props: {
  readonly canRespond: boolean;
  readonly onRespond: (interactionId: string, optionId: string) => void;
  readonly part: EveToolPart;
}) {
  const openRequest = () =>
    props.part.interaction?.status === "open" ? props.part.interaction : undefined;

  return (
    <div class="tool">
      <strong>{props.part.label}</strong> <em>{props.part.state}</em>
      <pre>{JSON.stringify(props.part.input, null, 2)}</pre>
      <Show when={props.part.output !== undefined}>
        <pre>{JSON.stringify(props.part.output, null, 2)}</pre>
      </Show>
      <Show when={props.part.error}>{(error) => <p class="error">{error().message}</p>}</Show>
      <Show when={openRequest()}>
        {(interaction) => (
          <div>
            <p>{interaction().request?.prompt}</p>
            <For each={interaction().request?.options ?? []}>
              {(option) => (
                <button
                  disabled={!props.canRespond}
                  onClick={() => props.onRespond(interaction().interactionId, option.id)}
                  type="button"
                >
                  {option.label}
                </button>
              )}
            </For>
          </div>
        )}
      </Show>
    </div>
  );
}

function PartView(props: {
  readonly canRespond: boolean;
  readonly onRespond: (interactionId: string, optionId: string) => void;
  readonly part: EveMessagePart;
}) {
  return (
    <Switch>
      <Match when={props.part.type === "text" && props.part}>
        {(part) => <div>{part().text}</div>}
      </Match>
      <Match when={props.part.type === "reasoning" && props.part}>
        {(part) => <div class="reasoning">{part().text}</div>}
      </Match>
      <Match when={props.part.type === "tool" && props.part}>
        {(part) => (
          <ToolBlock canRespond={props.canRespond} onRespond={props.onRespond} part={part()} />
        )}
      </Match>
    </Switch>
  );
}

export default function App() {
  const agent = useEveAgent();
  const [draft, setDraft] = createSignal("");
  const isInputDisabled = () => agent.status() !== "idle";
  const turnOpen = () => activeTurn(agent.view()) !== undefined;
  const respond = (interactionId: string, optionId: string) =>
    void agent.respond([{ interactionId, optionId }]);

  function submit() {
    const text = draft().trim();
    if (text.length === 0 || isInputDisabled()) return;
    setDraft("");
    void agent.send(text);
  }

  return (
    <main>
      <header>
        <span>eve / agent</span>
        <span>{agent.status()}</span>
      </header>

      <Show when={agent.error()}>{(error) => <p class="error">{error().message}</p>}</Show>

      <Show
        when={agent.messages().length > 0}
        fallback={
          <p>Ask for the weather in Vienna, or tell the agent to explain the tools it called.</p>
        }
      >
        <div class="messages">
          <For each={agent.messages()}>
            {(message) => (
              <div class="message" data-role={message.role}>
                <For each={message.parts}>
                  {(part) => (
                    <PartView canRespond={!isInputDisabled()} onRespond={respond} part={part} />
                  )}
                </For>
              </div>
            )}
          </For>
        </div>
      </Show>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <textarea
          disabled={isInputDisabled()}
          onInput={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder="Send a message..."
          rows={2}
          value={draft()}
        />
        <Show
          when={turnOpen()}
          fallback={
            <button disabled={isInputDisabled() || draft().trim().length === 0} type="submit">
              Send
            </button>
          }
        >
          <button onClick={() => void agent.cancel()} type="button">
            Stop
          </button>
        </Show>
      </form>
    </main>
  );
}
