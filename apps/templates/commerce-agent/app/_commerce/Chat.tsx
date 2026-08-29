"use client";

import { defaultMessageReducer, useEveAgent, type EveMessage } from "eve/react";
import { type FormEvent, useMemo, useState } from "react";

import { CheckoutHandoff } from "./CheckoutHandoff";

const MERCHANT_TOOL_PREFIX = "merchant__";

export function Chat() {
  const reducer = useMemo(() => defaultMessageReducer(), []);
  const agent = useEveAgent({ reducer });
  const [draft, setDraft] = useState("");

  const messages = agent.data.messages;
  const checkout = latestCheckout(messages);
  const isBusy = agent.status === "submitted" || agent.status === "streaming";

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (text.length === 0 || isBusy) {
      return;
    }
    setDraft("");
    await agent.send(text);
  }

  return (
    <main className="layout">
      <section className="conversation">
        <ul className="feed">
          {messages.map((message) => (
            <li className={`row role-${message.role}`} key={message.id}>
              <div className="bubble">{renderText(message)}</div>
            </li>
          ))}
          {isBusy ? (
            <li className="row role-assistant">
              <div className="bubble muted">Thinking…</div>
            </li>
          ) : null}
        </ul>

        <form className="composer" onSubmit={onSubmit}>
          <input
            aria-label="Message"
            onChange={(event) => setDraft(event.target.value)}
            placeholder="What are you shopping for?"
            value={draft}
          />
          <button disabled={isBusy || draft.trim().length === 0} type="submit">
            Send
          </button>
        </form>
      </section>

      {checkout === undefined ? null : (
        // Keying on the tool call remounts the panel for each new merchant
        // response, so the handoff is re-resolved from fresh state.
        <CheckoutHandoff
          checkoutId={checkout.checkoutId}
          key={`${checkout.checkoutId}:${checkout.toolCallId}`}
        />
      )}
    </main>
  );
}

function renderText(message: EveMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/**
 * Finds the checkout the merchant most recently reported on.
 *
 * The id is all this takes from the stream; the panel re-reads the
 * session server-side rather than trusting the browser's copy.
 */
function latestCheckout(
  messages: readonly EveMessage[],
): { checkoutId: string; toolCallId: string } | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const parts = messages[index]?.parts ?? [];
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex--) {
      const part = parts[partIndex];
      if (
        part === undefined ||
        part.type !== "dynamic-tool" ||
        part.state !== "output-available" ||
        !part.toolName.startsWith(MERCHANT_TOOL_PREFIX)
      ) {
        continue;
      }
      const checkoutId = readCheckoutId(part.output);
      if (checkoutId !== undefined) {
        return { checkoutId, toolCallId: part.toolCallId };
      }
    }
  }
  return undefined;
}

function readCheckoutId(output: unknown): string | undefined {
  if (typeof output !== "object" || output === null) {
    return undefined;
  }
  const body = (output as { body?: unknown }).body;
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const id = (body as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}
