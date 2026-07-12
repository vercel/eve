import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentphoneContinuationToken,
  callAgentPhoneApi,
  resolveAgentPhoneApiKey,
  sendAgentPhoneMessage,
  makeAgentPhoneCall,
} from "./api.js";

describe("agentphoneContinuationToken", () => {
  it("joins from and to", () => {
    expect(agentphoneContinuationToken("+15551234567", "+15557654321")).toBe(
      "+15551234567:+15557654321",
    );
  });

  it("handles missing to", () => {
    expect(agentphoneContinuationToken("+15551234567", undefined)).toBe("+15551234567:");
  });
});

describe("resolveAgentPhoneApiKey", () => {
  afterEach(() => {
    delete process.env.AGENTPHONE_API_KEY;
  });

  it("uses a provided string", async () => {
    expect(await resolveAgentPhoneApiKey("key_direct")).toBe("key_direct");
  });

  it("calls a function provider", async () => {
    const provider = vi.fn().mockResolvedValue("key_async");
    expect(await resolveAgentPhoneApiKey(provider)).toBe("key_async");
  });

  it("falls back to AGENTPHONE_API_KEY env", async () => {
    process.env.AGENTPHONE_API_KEY = "key_env";
    expect(await resolveAgentPhoneApiKey()).toBe("key_env");
  });

  it("throws when no key is available", async () => {
    await expect(resolveAgentPhoneApiKey()).rejects.toThrow("AGENTPHONE_API_KEY is required.");
  });
});

describe("callAgentPhoneApi", () => {
  it("sends a Bearer-authed JSON request", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: "msg_123" }), { status: 200 }));

    const result = await callAgentPhoneApi({
      credentials: { apiKey: "key_test" },
      fetch: mockFetch,
      path: "/v1/messages",
      body: { to_number: "+15551234567", body: "Hello" },
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.agentphone.ai/v1/messages");
    expect(options.method).toBe("POST");
    expect(options.headers).toMatchObject({
      authorization: "Bearer key_test",
      "content-type": "application/json",
    });
    expect(JSON.parse(options.body as string)).toEqual({
      to_number: "+15551234567",
      body: "Hello",
    });
    expect(result.ok).toBe(true);
    expect(result.body).toEqual({ id: "msg_123" });
  });

  it("respects apiBaseUrl override", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));

    await callAgentPhoneApi({
      apiBaseUrl: "https://custom.api.test",
      credentials: { apiKey: "key_test" },
      fetch: mockFetch,
      path: "/v1/messages",
      body: {},
    });

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe("https://custom.api.test/v1/messages");
  });
});

describe("sendAgentPhoneMessage", () => {
  it("posts to /v1/messages with required fields", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: "msg_456", status: "sent" }), { status: 200 }),
      );

    const result = await sendAgentPhoneMessage({
      body: "Hello from eve",
      credentials: { apiKey: "key_test" },
      fetch: mockFetch,
      toNumber: "+15551234567",
    });

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string);
    expect(body.to_number).toBe("+15551234567");
    expect(body.body).toBe("Hello from eve");
    expect(result.ok).toBe(true);
  });

  it("includes optional fields when provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));

    await sendAgentPhoneMessage({
      agentId: "agt_123",
      body: "With media",
      credentials: { apiKey: "key_test" },
      fetch: mockFetch,
      fromNumber: "+15557654321",
      mediaUrls: ["https://example.com/photo.jpg"],
      numberId: "num_789",
      toNumber: "+15551234567",
    });

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string);
    expect(body.from_number).toBe("+15557654321");
    expect(body.number_id).toBe("num_789");
    expect(body.agent_id).toBe("agt_123");
    expect(body.media_urls).toEqual(["https://example.com/photo.jpg"]);
  });
});

describe("makeAgentPhoneCall", () => {
  it("posts to /v1/calls", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: "call_123" }), { status: 200 }));

    const result = await makeAgentPhoneCall({
      agentId: "agt_abc",
      credentials: { apiKey: "key_test" },
      fetch: mockFetch,
      initialGreeting: "Hello!",
      toNumber: "+15551234567",
    });

    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.agentphone.ai/v1/calls");
    const body = JSON.parse(options.body as string);
    expect(body.agentId).toBe("agt_abc");
    expect(body.toNumber).toBe("+15551234567");
    expect(body.initialGreeting).toBe("Hello!");
    expect(result.ok).toBe(true);
  });
});
