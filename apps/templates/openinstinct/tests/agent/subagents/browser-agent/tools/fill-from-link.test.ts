import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { SpendRequest } from "@stripe/link-sdk";
import * as WorkerAccess from "@agent/subagents/browser-agent/lib/access";
import * as OwnedBrowser from "@agent/subagents/browser-agent/lib/owned-browser";
import * as Autofill from "@agent/subagents/browser-agent/lib/autofill/native";
import fillFromLink from "@agent/subagents/browser-agent/tools/fill_from_link";
import { linkAuth } from "@agent/lib/link-auth";
import { toolContextFor } from "@tests/helpers/tool-context";

const fetchMock = vi.fn<typeof fetch>();
const scope = { userId: "user-1", workspaceId: "workspace-1" };
const input = {
  browserSessionId: "browser-1",
  spendRequestId: "spr_123",
  amount: 2306,
  currency: "usd",
};
const context = toolContextFor({ parentSessionId: "root-1" });
const access = vi.spyOn(WorkerAccess, "requireWorkerScope");
const owned = vi.spyOn(OwnedBrowser, "requireOwnedBrowserSession");
const origin = vi.spyOn(Autofill, "currentKernelPageOrigin");
const fill = vi.spyOn(Autofill, "fillWithKernelNativeAutofill");
const fillFields = vi.spyOn(Autofill, "fillKernelPaymentFields");
const token = vi.spyOn(context, "getToken");
const requireAuth = vi.spyOn(context, "requireAuth");

function approvedRequest(): SpendRequest {
  return {
    id: input.spendRequestId,
    status: "approved",
    amount: 2306,
    currency: "usd",
    credential_type: "card",
    merchant_url: "https://shop.example/checkout",
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    expires_at: 2082758400,
    card: {
      id: "card_123",
      brand: "visa",
      number: "4242424242424242",
      cvc: "098",
      exp_month: 12,
      exp_year: 2035,
      valid_until: "2035-12-01T00:00:00Z",
      billing_address: {
        name: "Test Buyer",
        line1: "1 Test St",
        country: "US",
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  access.mockResolvedValue(scope);
  owned.mockResolvedValue({
    createdAt: "2026-10-01T00:00:00Z",
    sessionId: "browser-1",
    workerSessionId: "worker-1",
  });
  token.mockResolvedValue({ token: "wallet-token-user-1" });
  origin.mockResolvedValue("https://shop.example");
  fill.mockResolvedValue({ filledClaims: 5, origin: "https://shop.example" });
  fillFields.mockResolvedValue({
    filledClaims: 3,
    origin: "https://shop.example",
  });
  fetchMock.mockImplementation(async () => Response.json(approvedRequest()));
});
afterEach(() => vi.unstubAllGlobals());

describe("Link browser bridge", () => {
  it("uses the real SDK to retrieve a scoped card and sends secrets only to the injector", async () => {
    const output = await fillFromLink.execute(input, context);
    expect(token).toHaveBeenCalledWith(linkAuth);
    expect(owned).toHaveBeenCalledWith(scope, input.browserSessionId);
    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("Missing SDK request");
    const [resource, options] = call;
    expect(resource).toEqual(
      expect.stringContaining("/spend_requests/spr_123?include=card")
    );
    expect(new Headers(options?.headers).get("Authorization")).toBe(
      "Bearer wallet-token-user-1"
    );
    expect(options).toMatchObject({
      method: "GET",
      redirect: "error",
      cache: "no-store",
    });
    const args = fill.mock.calls[0]?.[0];
    if (!args) throw new Error("Missing injector call");
    expect(Autofill.buildNativeAutofillPayload("payment", args.claims)).toEqual(
      {
        card: {
          name: "Test Buyer",
          number: "4242424242424242",
          cvc: "098",
          expiryMonth: "12",
          expiryYear: "2035",
        },
      }
    );
    expect(args.expectedOrigin).toBe("https://shop.example");
    expect(output).toEqual({
      success: true,
      spendRequestId: "spr_123",
      origin: "https://shop.example",
      amount: 2306,
      currency: "usd",
      filledClaims: 5,
    });
    expect(JSON.stringify(output)).not.toMatch(
      /4242424242424242|098|wallet-token|Test Buyer/u
    );
  });

  it.each([
    {
      fields: [
        { field: "number", selector: "#number" },
        { field: "expiration", selector: "#expiry", format: "MM/YY" },
        { field: "cvc", selector: "#cvc" },
      ],
    },
    {
      pageUrl: "https://shop.example/checkout",
      fields: [
        { field: "number", selector: "#number" },
        { field: "cvc", selector: "#cvc" },
        { field: "name", selector: "#name" },
      ],
    },
    {
      pageUrl: "https://shop.example/checkout",
      fields: [
        { field: "number", selector: "#number" },
        { field: "expiration", selector: "#expiry" },
        { field: "cvc", selector: "#cvc" },
      ],
    },
    {
      pageUrl: "https://shop.example/checkout",
      fields: [
        { field: "number", selector: "#number" },
        { field: "expiration", selector: "#expiry", format: "MM/YY" },
        { field: "cvc", selector: "#cvc", format: "MM/YY" },
      ],
    },
  ])(
    "rejects incomplete or contradictory hosted field contracts: %j",
    (change) => {
      const schema = fillFromLink.inputSchema;
      if (!(schema instanceof z.ZodType))
        throw new Error("Expected the authored field schema.");
      expect(schema.safeParse({ ...input, ...change }).success).toBe(false);
    }
  );

  it.each(["MM/YY", "MM/YYYY"] as const)(
    "fills hosted fields through the approved wallet using %s expiration",
    async (format) => {
      const bindings = [
        {
          field: "number" as const,
          selector: "#number",
          frameUrl: "https://assets.braintreegateway.com/number",
        },
        { field: "expiration" as const, selector: "#expiry", format },
        { field: "cvc" as const, selector: "#cvc" },
      ];
      const output = await fillFromLink.execute(
        {
          ...input,
          pageUrl: "https://shop.example/checkout",
          fields: bindings,
        },
        context
      );
      expect(fill).not.toHaveBeenCalled();
      expect(fillFields).toHaveBeenCalledWith(
        expect.objectContaining({
          pageUrl: "https://shop.example/checkout",
          expectedOrigin: "https://shop.example",
          fields: [
            {
              selector: "#number",
              frameUrl: bindings[0]?.frameUrl,
              value: "4242424242424242",
            },
            {
              selector: "#expiry",
              frameUrl: undefined,
              value: format === "MM/YY" ? "12/35" : "12/2035",
            },
            { selector: "#cvc", frameUrl: undefined, value: "098" },
          ],
        })
      );
      expect(origin).toHaveBeenCalledWith(
        expect.objectContaining({ pageUrl: "https://shop.example/checkout" })
      );
      expect(token).toHaveBeenCalledWith(linkAuth);
      expect(output).toEqual(expect.objectContaining({ filledClaims: 3 }));
      expect(JSON.stringify(output)).not.toMatch(
        /4242424242424242|098|wallet-token/u
      );
    }
  );

  it("preserves the month claim when binding separate expiration selects", async () => {
    const request = approvedRequest();
    fetchMock.mockResolvedValue(
      Response.json({ ...request, card: { ...request.card, exp_month: 1 } })
    );
    await fillFromLink.execute(
      {
        ...input,
        pageUrl: "https://shop.example/checkout",
        fields: [
          { field: "number", selector: "#number" },
          { field: "exp_month", selector: "#month" },
          { field: "exp_year", selector: "#year" },
          { field: "cvc", selector: "#cvc" },
        ],
      },
      context
    );
    const call = fillFields.mock.calls[0]?.[0];
    if (!call) throw new Error("Missing bound-field injection.");
    expect(call.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          selector: "#month",
          value: "01",
          token: "cc-exp-month",
        }),
        expect.objectContaining({ selector: "#year", value: "2035" }),
      ])
    );
  });

  it("fills the billing ZIP from the approved Link card without returning it", async () => {
    const request = approvedRequest();
    fetchMock.mockResolvedValue(
      Response.json({
        ...request,
        card: {
          ...request.card,
          billing_address: {
            ...request.card?.billing_address,
            postal_code: " 94107 ",
          },
        },
      })
    );
    const boundInput = {
      ...input,
      pageUrl: "https://shop.example/checkout",
      fields: [
        { field: "number" as const, selector: "#number" },
        { field: "exp_month" as const, selector: "#month" },
        { field: "exp_year" as const, selector: "#year" },
        { field: "cvc" as const, selector: "#cvc" },
        { field: "name" as const, selector: "#name" },
        { field: "postal_code" as const, selector: "#BillingZip" },
      ],
    };
    const schema = fillFromLink.inputSchema;
    if (!(schema instanceof z.ZodType))
      throw new Error("Missing field schema.");
    expect(schema.safeParse(boundInput).success).toBe(true);
    const output = await fillFromLink.execute(boundInput, context);
    expect(fillFields.mock.calls[0]?.[0].fields).toContainEqual({
      selector: "#BillingZip",
      frameUrl: undefined,
      value: "94107",
      token: "postal-code",
    });
    expect(fill).not.toHaveBeenCalled();
    expect(JSON.stringify(output)).not.toMatch(/94107|4242424242424242|098/u);
  });

  it.each([undefined, "", "   "])(
    "stops before filling when Link omits a bound billing ZIP: %j",
    async (postalCode) => {
      const request = approvedRequest();
      fetchMock.mockResolvedValue(
        Response.json({
          ...request,
          card: {
            ...request.card,
            billing_address: {
              ...request.card?.billing_address,
              postal_code: postalCode,
            },
          },
        })
      );
      await expect(
        fillFromLink.execute(
          {
            ...input,
            pageUrl: "https://shop.example/checkout",
            fields: [
              { field: "number", selector: "#number" },
              { field: "expiration", selector: "#expiry", format: "MM/YY" },
              { field: "cvc", selector: "#cvc" },
              { field: "postal_code", selector: "#BillingZip" },
            ],
          },
          context
        )
      ).rejects.toThrow("Link has not supplied this card's billing ZIP");
      expect(fillFields).not.toHaveBeenCalled();
      expect(fill).not.toHaveBeenCalled();
    }
  );

  it("passes the Link billing ZIP to native autofill as a private claim", async () => {
    const request = approvedRequest();
    fetchMock.mockResolvedValue(
      Response.json({
        ...request,
        card: {
          ...request.card,
          billing_address: {
            ...request.card?.billing_address,
            postal_code: "K1A 0B1",
          },
        },
      })
    );
    const output = await fillFromLink.execute(input, context);
    expect(fill.mock.calls[0]?.[0].claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ token: "postal-code", value: "K1A 0B1" }),
      ])
    );
    expect(JSON.stringify(output)).not.toContain("K1A 0B1");
  });

  it("redacts and does not retry an uncertain hosted-field fill", async () => {
    fillFields.mockRejectedValueOnce(new Error("4242424242424242"));
    const result = fillFromLink.execute(
      {
        ...input,
        pageUrl: "https://shop.example/checkout",
        fields: [
          { field: "number", selector: "#number" },
          { field: "expiration", selector: "#expiry", format: "MM/YY" },
          { field: "cvc", selector: "#cvc" },
        ],
      },
      context
    );
    await expect(result).rejects.toThrow("could not be confirmed");
    await expect(result).rejects.not.toHaveProperty("cause");
    expect(fillFields).toHaveBeenCalledOnce();
    expect(fill).not.toHaveBeenCalled();
  });

  it.each([
    "pending_approval",
    "requires_action",
    "denied",
    "expired",
    "submitted",
    "succeeded",
    "canceled",
    "future_status",
  ])("rejects %s requests", async (status) => {
    fetchMock.mockResolvedValue(
      Response.json({ ...approvedRequest(), status })
    );
    await expect(fillFromLink.execute(input, context)).rejects.toThrow(
      "not currently approved"
    );
    expect(fill).not.toHaveBeenCalled();
  });

  it.each([
    { id: "other_request" },
    { amount: 1 },
    { currency: "eur" },
    { merchant_url: "http://shop.example/checkout" },
    { merchant_url: "https://attacker.example" },
    { merchant_url: "https://user:pass@shop.example" },
    { merchant_url: undefined },
    { credential_type: "shared_payment_token" },
    { shared_payment_token: { id: "spt_secret" } },
    { link_pay_token: "lpt_secret" },
    { recurring: { interval: "month", interval_count: 1 } },
    { expires_at: 1 },
    { card: undefined },
  ])(
    "rejects mismatched, expired, or unsupported requests: %j",
    async (change) => {
      fetchMock.mockResolvedValue(
        Response.json({ ...approvedRequest(), ...change })
      );
      await expect(fillFromLink.execute(input, context)).rejects.toThrow(
        /Link|checkout/u
      );
      expect(fill).not.toHaveBeenCalled();
    }
  );

  it.each([
    { cvc: undefined },
    { number: "invalid" },
    { exp_year: 2020 },
    { valid_until: "invalid" },
    { valid_until: "1" },
    { billing_address: undefined },
  ])("rejects unusable card data: %j", async (change) => {
    const request = approvedRequest();
    fetchMock.mockResolvedValue(
      Response.json({ ...request, card: { ...request.card, ...change } })
    );
    await expect(fillFromLink.execute(input, context)).rejects.toThrow(
      /Link|checkout/u
    );
    expect(fill).not.toHaveBeenCalled();
  });

  it("handles a request absent from this wallet", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    await expect(fillFromLink.execute(input, context)).rejects.toThrow(
      "not currently approved"
    );
    expect(fill).not.toHaveBeenCalled();
  });

  it.each([access, owned])(
    "rejects unowned sessions before wallet access",
    async (check) => {
      check.mockRejectedValueOnce(new Error("not owned"));
      await expect(fillFromLink.execute(input, context)).rejects.toThrow(
        "not owned"
      );
      expect(token).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(fill).not.toHaveBeenCalled();
    }
  );

  it("preserves Eve authorization suspension", async () => {
    const challenge = new Error("connect-wallet");
    token.mockRejectedValueOnce(challenge);
    await expect(fillFromLink.execute(input, context)).rejects.toBe(challenge);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requests reauthorization on 401 without exposing the response", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ error: "secret-response" }, { status: 401 })
    );
    requireAuth.mockImplementationOnce(() => {
      throw new Error("reauthorize");
    });
    await expect(fillFromLink.execute(input, context)).rejects.toThrow(
      "reauthorize"
    );
    expect(requireAuth).toHaveBeenCalledWith(linkAuth);
    expect(fill).not.toHaveBeenCalled();
  });

  it("redacts SDK error bodies and causes", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ error: "4242424242424242" }, { status: 500 })
    );
    const result = fillFromLink.execute(input, context);
    await expect(result).rejects.toThrow("Could not retrieve");
    await expect(result).rejects.not.toHaveProperty("cause");
    expect(fill).not.toHaveBeenCalled();
  });

  it.each([
    [
      "bound",
      "Each binding must identify one visible payment input in the approved checkout; binding 2 matched 0.",
    ],
    ["native", "Card autofill left required fields empty: security code."],
  ])(
    "surfaces a %s fill's checkout-state failure without its cause",
    async (path, message) => {
      const bound = path === "bound";
      (bound ? fillFields : fill).mockRejectedValueOnce(
        new Autofill.PaymentFillError(message)
      );
      const result = fillFromLink.execute(
        bound
          ? {
              ...input,
              pageUrl: "https://shop.example/checkout",
              fields: [
                { field: "number", selector: "#number" },
                { field: "expiration", selector: "#expiry", format: "MM/YY" },
                { field: "cvc", selector: "#cvc" },
              ],
            }
          : input,
        context
      );
      await expect(result).rejects.toThrow(
        `${message} Link card filling could not be confirmed.`
      );
      await expect(result).rejects.not.toHaveProperty("cause");
    }
  );

  it("does not return or retry an ambiguous injector error", async () => {
    fill.mockRejectedValueOnce(new Error("4242424242424242"));
    const result = fillFromLink.execute(input, context);
    await expect(result).rejects.toThrow("could not be confirmed");
    await expect(result).rejects.not.toHaveProperty("cause");
    expect(fill).toHaveBeenCalledOnce();
  });
});
