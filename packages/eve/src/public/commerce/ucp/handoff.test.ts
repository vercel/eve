import { describe, expect, it } from "vitest";

import { resolveUcpCheckoutHandoff } from "#public/commerce/ucp/handoff.js";

const VERSION = "2026-04-08";

function checkout(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    currency: "USD",
    id: "chk_1",
    line_items: [],
    ucp: { capabilities: {}, version: VERSION },
    ...overrides,
  };
}

function embeddedEnvelope(delegate: readonly string[]): Record<string, unknown> {
  return {
    services: {
      "dev.ucp.shopping": [{ config: { delegate }, transport: "embedded", version: VERSION }],
    },
    version: VERSION,
  };
}

describe("resolveUcpCheckoutHandoff: conversational continuation", () => {
  it("asks for an update while the checkout is incomplete", () => {
    const handoff = resolveUcpCheckoutHandoff(
      checkout({
        messages: [
          {
            code: "missing",
            content: "Buyer email is required",
            path: "$.buyer.email",
            severity: "recoverable",
            type: "error",
          },
        ],
        status: "incomplete",
      }),
    );

    expect(handoff.kind).toBe("conversational");
    if (handoff.kind !== "conversational") return;
    expect(handoff.next).toBe("update");
    expect(handoff.blockers.map((message) => message.code)).toEqual(["missing"]);
    expect(handoff.checkoutId).toBe("chk_1");
    expect(handoff.version).toBe(VERSION);
  });

  it("asks for completion once the business is ready", () => {
    const handoff = resolveUcpCheckoutHandoff(checkout({ status: "ready_for_complete" }));
    expect(handoff).toMatchObject({ blockers: [], kind: "conversational", next: "complete" });
  });

  it("asks for polling while the order is being placed", () => {
    const handoff = resolveUcpCheckoutHandoff(checkout({ status: "complete_in_progress" }));
    expect(handoff).toMatchObject({ kind: "conversational", next: "poll" });
  });

  it("surfaces an available continue_url without forcing a handoff", () => {
    const handoff = resolveUcpCheckoutHandoff(
      checkout({ continue_url: "https://merchant.example.com/c/chk_1", status: "incomplete" }),
    );
    expect(handoff).toMatchObject({
      continueUrl: "https://merchant.example.com/c/chk_1",
      kind: "conversational",
    });
  });

  it("keeps an unrecoverable error conversational, since new inputs may still work", () => {
    const handoff = resolveUcpCheckoutHandoff(
      checkout({
        continue_url: "https://merchant.example.com/c/chk_1",
        messages: [{ code: "out_of_stock", severity: "unrecoverable", type: "error" }],
        status: "incomplete",
      }),
    );
    expect(handoff.kind).toBe("conversational");
  });
});

describe("resolveUcpCheckoutHandoff: continue_url", () => {
  it("hands off on escalation and reports why", () => {
    const handoff = resolveUcpCheckoutHandoff(
      checkout({
        continue_url: "https://merchant.example.com/c/chk_1",
        messages: [
          { code: "eligibility_invalid", severity: "requires_buyer_input", type: "error" },
        ],
        status: "requires_escalation",
      }),
    );

    expect(handoff).toMatchObject({
      kind: "continue_url",
      reason: "requires_buyer_input",
      url: "https://merchant.example.com/c/chk_1",
    });
  });

  it("hands off when a buyer-review severity appears under a non-escalated status", () => {
    const handoff = resolveUcpCheckoutHandoff(
      checkout({
        continue_url: "https://merchant.example.com/c/chk_1",
        messages: [{ severity: "requires_buyer_review", type: "error" }],
        status: "ready_for_complete",
      }),
    );
    expect(handoff).toMatchObject({ kind: "continue_url", reason: "requires_buyer_review" });
  });

  it("falls back to escalation when no severity names a buyer action", () => {
    const handoff = resolveUcpCheckoutHandoff(
      checkout({
        continue_url: "https://merchant.example.com/c/chk_1",
        status: "requires_escalation",
      }),
    );
    expect(handoff).toMatchObject({ kind: "continue_url", reason: "escalation" });
  });

  it("fails when the business escalates without a continue_url", () => {
    const handoff = resolveUcpCheckoutHandoff(checkout({ status: "requires_escalation" }));
    expect(handoff).toMatchObject({ kind: "failed", reason: "handoff_unavailable" });
  });
});

describe("resolveUcpCheckoutHandoff: embedded checkout", () => {
  it("builds an embedded URL from the session's accepted delegations", () => {
    const handoff = resolveUcpCheckoutHandoff(
      checkout({
        continue_url: "https://merchant.example.com/checkout/abc123?ref=agent",
        status: "requires_escalation",
        ucp: embeddedEnvelope(["payment.credential", "window.open"]),
      }),
      { embedded: { colorScheme: "dark", delegate: ["payment.credential"] } },
    );

    expect(handoff.kind).toBe("embedded");
    if (handoff.kind !== "embedded") return;
    expect(handoff.delegate).toEqual(["payment.credential"]);
    expect(handoff.protocolVersion).toBe(VERSION);
    expect(handoff.continueUrl).toBe("https://merchant.example.com/checkout/abc123?ref=agent");

    const url = new URL(handoff.url);
    expect(url.searchParams.get("ref")).toBe("agent");
    expect(url.searchParams.get("ec_version")).toBe(VERSION);
    expect(url.searchParams.get("ec_delegate")).toBe("payment.credential");
    expect(url.searchParams.get("ec_color_scheme")).toBe("dark");
    expect(url.searchParams.get("ec_auth")).toBeNull();
  });

  it("offers every accepted delegation when the host requests none specifically", () => {
    const handoff = resolveUcpCheckoutHandoff(
      checkout({
        continue_url: "https://merchant.example.com/checkout/abc123",
        status: "requires_escalation",
        ucp: embeddedEnvelope(["payment.credential", "window.open"]),
      }),
    );
    expect(handoff).toMatchObject({ delegate: ["payment.credential", "window.open"] });
  });

  it("redirects instead when the session offers no embedded binding", () => {
    const handoff = resolveUcpCheckoutHandoff(
      checkout({
        continue_url: "https://merchant.example.com/checkout/abc123",
        status: "requires_escalation",
        ucp: {
          services: {
            "dev.ucp.shopping": [
              { endpoint: "https://merchant.example.com/ucp/v1", transport: "rest" },
            ],
          },
          version: VERSION,
        },
      }),
    );
    expect(handoff.kind).toBe("continue_url");
  });

  it("redirects when the embedded binding omits config.delegate", () => {
    const handoff = resolveUcpCheckoutHandoff(
      checkout({
        continue_url: "https://merchant.example.com/checkout/abc123",
        status: "requires_escalation",
        ucp: {
          services: { "dev.ucp.shopping": [{ transport: "embedded", version: VERSION }] },
          version: VERSION,
        },
      }),
    );
    expect(handoff.kind).toBe("continue_url");
  });

  it("redirects when the caller opts out", () => {
    const handoff = resolveUcpCheckoutHandoff(
      checkout({
        continue_url: "https://merchant.example.com/checkout/abc123",
        status: "requires_escalation",
        ucp: embeddedEnvelope(["payment.credential"]),
      }),
      { embedded: false },
    );
    expect(handoff.kind).toBe("continue_url");
  });

  it("applies the business-defined embedded auth token", () => {
    const handoff = resolveUcpCheckoutHandoff(
      checkout({
        continue_url: "https://merchant.example.com/checkout/abc123",
        status: "requires_escalation",
        ucp: embeddedEnvelope([]),
      }),
      { embedded: { auth: "tok_123" } },
    );
    expect(handoff.kind).toBe("embedded");
    if (handoff.kind !== "embedded") return;
    const url = new URL(handoff.url);
    expect(url.searchParams.get("ec_auth")).toBe("tok_123");
    expect(url.searchParams.get("ec_delegate")).toBeNull();
  });
});

describe("resolveUcpCheckoutHandoff: terminal states", () => {
  it("reports the placed order", () => {
    const handoff = resolveUcpCheckoutHandoff(
      checkout({
        order: { id: "ord_1", permalink_url: "https://merchant.example.com/orders/ord_1" },
        status: "completed",
      }),
    );
    expect(handoff).toMatchObject({
      kind: "completed",
      order: { id: "ord_1", permalink_url: "https://merchant.example.com/orders/ord_1" },
    });
  });

  it("reports cancellation", () => {
    expect(resolveUcpCheckoutHandoff(checkout({ status: "canceled" }))).toMatchObject({
      kind: "canceled",
    });
  });
});

describe("resolveUcpCheckoutHandoff: failures", () => {
  it("treats a ucp.status error envelope as a protocol error and keeps the offered URL", () => {
    const handoff = resolveUcpCheckoutHandoff({
      continue_url: "https://merchant.example.com/",
      messages: [{ code: "out_of_stock", severity: "unrecoverable", type: "error" }],
      ucp: { status: "error", version: VERSION },
    });

    expect(handoff).toMatchObject({
      continueUrl: "https://merchant.example.com/",
      kind: "failed",
      reason: "protocol_error",
    });
    expect(handoff.messages).toHaveLength(1);
  });

  it("reports an HTTP failure with no usable payload", () => {
    const handoff = resolveUcpCheckoutHandoff({
      body: "Bad Gateway",
      status: 502,
      statusText: "Bad Gateway",
    });
    expect(handoff).toMatchObject({ httpStatus: 502, kind: "failed", reason: "http_error" });
  });

  it("reports an unrecognized body", () => {
    expect(resolveUcpCheckoutHandoff(null)).toMatchObject({
      kind: "failed",
      reason: "unrecognized_response",
    });
  });

  it("reports a body carrying no recognizable status", () => {
    expect(resolveUcpCheckoutHandoff(checkout())).toMatchObject({
      kind: "failed",
      reason: "unrecognized_response",
    });
  });
});

describe("resolveUcpCheckoutHandoff: connection tool results", () => {
  it("unwraps an eve OpenAPI connection tool result", () => {
    const handoff = resolveUcpCheckoutHandoff({
      body: checkout({ status: "ready_for_complete" }),
      status: 201,
      statusText: "Created",
    });
    expect(handoff).toMatchObject({ kind: "conversational", next: "complete" });
  });

  it("trusts a 4xx body that still carries a checkout status", () => {
    const handoff = resolveUcpCheckoutHandoff({
      body: checkout({
        continue_url: "https://merchant.example.com/c/chk_1",
        status: "requires_escalation",
      }),
      status: 409,
      statusText: "Conflict",
    });
    expect(handoff.kind).toBe("continue_url");
  });
});
