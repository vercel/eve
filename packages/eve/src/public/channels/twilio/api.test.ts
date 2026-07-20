import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { callTwilioApi, sendTwilioMessage, updateTwilioCall } from "#public/channels/twilio/api.js";

interface FetchCall {
  readonly url: string;
  readonly authorization: string | null;
  readonly body: URLSearchParams;
}

function buildFetchMock(): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const mockFetch: typeof fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      authorization: headers.get("authorization"),
      body: new URLSearchParams(String(init?.body ?? "")),
      url: String(input),
    });
    return new Response(JSON.stringify({ sid: "SM123", ok: true }), {
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: mockFetch, calls };
}

describe("Twilio REST API wrapper", () => {
  const ORIGINAL_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
  const ORIGINAL_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

  beforeEach(() => {
    process.env.TWILIO_ACCOUNT_SID = "AC123";
    process.env.TWILIO_AUTH_TOKEN = "token";
  });

  afterEach(() => {
    if (ORIGINAL_ACCOUNT_SID === undefined) {
      delete process.env.TWILIO_ACCOUNT_SID;
    } else {
      process.env.TWILIO_ACCOUNT_SID = ORIGINAL_ACCOUNT_SID;
    }
    if (ORIGINAL_AUTH_TOKEN === undefined) {
      delete process.env.TWILIO_AUTH_TOKEN;
    } else {
      process.env.TWILIO_AUTH_TOKEN = ORIGINAL_AUTH_TOKEN;
    }
  });

  it("calls Twilio with Basic auth and form-encoded body fields", async () => {
    const mock = buildFetchMock();

    const result = await callTwilioApi({
      apiBaseUrl: "https://twilio.test",
      body: { Body: "hello", Optional: undefined, To: "+15551234567" },
      fetch: mock.fetch,
      path: "/2010-04-01/Accounts/AC123/Messages.json",
    });

    expect(result.ok).toBe(true);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.url).toBe("https://twilio.test/2010-04-01/Accounts/AC123/Messages.json");
    expect(mock.calls[0]!.authorization).toBe(
      `Basic ${Buffer.from("AC123:token").toString("base64")}`,
    );
    expect(Object.fromEntries(mock.calls[0]!.body)).toEqual({
      Body: "hello",
      To: "+15551234567",
    });
  });

  it("returns non-ok responses instead of throwing on Twilio HTTP errors", async () => {
    const mockFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ code: 20_001, message: "bad request" }), { status: 400 });

    const result = await callTwilioApi({
      body: { Body: "hello" },
      fetch: mockFetch,
      path: "/2010-04-01/Accounts/AC123/Messages.json",
    });

    expect(result).toEqual({
      body: { code: 20_001, message: "bad request" },
      ok: false,
      status: 400,
    });
  });

  it("sendTwilioMessage posts to the Messages resource with normal defaults", async () => {
    const mock = buildFetchMock();

    await sendTwilioMessage({
      apiBaseUrl: "https://twilio.test",
      body: "reply",
      fetch: mock.fetch,
      from: "+15557654321",
      to: "+15551234567",
    });

    expect(mock.calls[0]!.url).toBe("https://twilio.test/2010-04-01/Accounts/AC123/Messages.json");
    expect(Object.fromEntries(mock.calls[0]!.body)).toMatchObject({
      Body: "reply",
      From: "+15557654321",
      To: "+15551234567",
    });
  });

  it("sendTwilioMessage supports MessagingServiceSid instead of From", async () => {
    const mock = buildFetchMock();

    await sendTwilioMessage({
      apiBaseUrl: "https://twilio.test",
      body: "reply",
      fetch: mock.fetch,
      messagingServiceSid: "MG123",
      to: "+15551234567",
    });

    expect(Object.fromEntries(mock.calls[0]!.body)).toMatchObject({
      MessagingServiceSid: "MG123",
      To: "+15551234567",
    });
  });

  it("updateTwilioCall posts replacement TwiML to the Calls resource", async () => {
    const mock = buildFetchMock();

    await updateTwilioCall({
      apiBaseUrl: "https://twilio.test",
      callSid: "CA123",
      fetch: mock.fetch,
      twiml: "<Response><Say>Hello</Say></Response>",
    });

    expect(mock.calls[0]!.url).toBe(
      "https://twilio.test/2010-04-01/Accounts/AC123/Calls/CA123.json",
    );
    expect(Object.fromEntries(mock.calls[0]!.body)).toEqual({
      Twiml: "<Response><Say>Hello</Say></Response>",
    });
  });

  it("throws before calling fetch when no sender is configured", async () => {
    const mock = buildFetchMock();

    await expect(
      sendTwilioMessage({
        body: "reply",
        fetch: mock.fetch,
        to: "+15551234567",
      }),
    ).rejects.toThrow("requires from or messagingServiceSid");
    expect(mock.calls).toHaveLength(0);
  });
});
