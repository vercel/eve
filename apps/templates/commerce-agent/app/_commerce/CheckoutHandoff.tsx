"use client";

import type { UcpCheckoutHandoff } from "eve/commerce/ucp";
import { useEffect, useState } from "react";

/**
 * Renders the three ways a checkout can continue.
 *
 * Every branch of the union is handled here, which is the point of the
 * contract: `conversational` means the agent is still working and the panel
 * stays out of the way, `embedded` means the merchant's own checkout can be
 * framed in place, and `continue_url` means the buyer leaves for the
 * merchant's site.
 */
export function CheckoutHandoff(props: { readonly checkoutId: string }) {
  const handoff = useHandoff(props.checkoutId);

  if (handoff === undefined) {
    return <aside className="panel">Reading checkout…</aside>;
  }

  switch (handoff.kind) {
    case "conversational":
      return (
        <aside className="panel">
          <h2>Working on it</h2>
          <p className="muted">Next step: {handoff.next}</p>
          <Messages messages={handoff.blockers} />
        </aside>
      );

    case "embedded":
      return (
        <aside className="panel">
          <h2>Review and place your order</h2>
          <iframe
            allow="payment"
            className="embedded-checkout"
            src={handoff.url}
            title="Merchant checkout"
          />
          <p className="muted">
            <a href={handoff.continueUrl} rel="noreferrer" target="_blank">
              Open on the merchant's site instead
            </a>
          </p>
        </aside>
      );

    case "continue_url":
      return (
        <aside className="panel">
          <h2>Finish on the merchant's site</h2>
          <Messages messages={handoff.messages} />
          <a className="button" href={handoff.url} rel="noreferrer" target="_blank">
            Continue checkout
          </a>
        </aside>
      );

    case "completed":
      return (
        <aside className="panel">
          <h2>Order placed</h2>
          {handoff.order?.permalink_url === undefined ? (
            <p className="muted">Order {handoff.order?.id ?? handoff.checkoutId}</p>
          ) : (
            <a href={handoff.order.permalink_url} rel="noreferrer" target="_blank">
              View your order
            </a>
          )}
        </aside>
      );

    case "canceled":
      return (
        <aside className="panel">
          <h2>Checkout canceled</h2>
          <p className="muted">Start a new one to keep shopping.</p>
        </aside>
      );

    case "failed":
      return (
        <aside className="panel variant-error">
          <h2>Checkout unavailable</h2>
          <p className="muted">{handoff.reason}</p>
          <Messages messages={handoff.messages} />
          {handoff.continueUrl === undefined ? null : (
            <a className="button" href={handoff.continueUrl} rel="noreferrer" target="_blank">
              Open the merchant's site
            </a>
          )}
        </aside>
      );
  }
}

function Messages(props: { readonly messages: UcpCheckoutHandoff["messages"] }) {
  if (props.messages.length === 0) {
    return null;
  }
  return (
    <ul className="messages">
      {props.messages.map((message, index) => (
        <li className={`message type-${message.type}`} key={`${message.code ?? "m"}:${index}`}>
          {message.content ?? message.code ?? message.type}
        </li>
      ))}
    </ul>
  );
}

function useHandoff(checkoutId: string): UcpCheckoutHandoff | undefined {
  const [handoff, setHandoff] = useState<UcpCheckoutHandoff | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    setHandoff(undefined);

    void fetch(`/api/checkout/${encodeURIComponent(checkoutId)}`, { signal: controller.signal })
      .then((response) => response.json() as Promise<UcpCheckoutHandoff>)
      .then(setHandoff)
      .catch(() => {
        if (!controller.signal.aborted) {
          setHandoff({ kind: "failed", messages: [], reason: "http_error" });
        }
      });

    return () => controller.abort();
  }, [checkoutId]);

  return handoff;
}
