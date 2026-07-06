import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler, type ChannelAdapter } from "#channel/adapter.js";
import { isCompiledChannel, type CompiledChannel } from "#channel/compiled-channel.js";
import { isHttpRouteDefinition } from "#channel/routes.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import type { TwilioTextMessage } from "#public/channels/twilio/inbound.js";
import { twilioChannel, type TwilioContext } from "#public/channels/twilio/twilioChannel.js";
import { signTwilioRequest } from "#public/channels/twilio/verify.js";

const AUTH_TOKEN = "test-auth-token";

function asCompiled<T = unknown>(channel: unknown): CompiledChannel<T> {
  if (!isCompiledChannel(channel)) {
    throw new Error("Expected a CompiledChannel.");
  }
  return channel as CompiledChannel<T>;
}

function getAdapter(channel: unknown): ChannelAdapter<any> {
  return asCompiled(channel).adapter;
}

function withState(
  adapter: ChannelAdapter<any>,
  state: Record<string, unknown>,
): ChannelAdapter<any> {
  return { ...adapter, state: { ...adapter.state, ...state } };
}

function stubAccessor() {
  return { get: () => undefined, set: () => {} } as any;
}

const stubAlsContext = (() => {
  const ctx = new ContextContainer();
  ctx.setVirtualContext(SessionKey, {
    sessionId: "test-session",
    auth: { current: null, initiator: null },
    turn: { id: "test-turn", sequence: 0 },
  });
  return ctx;
})();

function callEvent(
  adapter: ChannelAdapter,
  event: HandleMessageStreamEvent,
  ctx: any,
): Promise<HandleMessageStreamEvent> {
  return contextStorage.run(stubAlsContext, () => callAdapterEventHandler(adapter, event, ctx));
}

function makeEvent<T extends HandleMessageStreamEvent["type"]>(
  type: T,
  data: unknown,
): HandleMessageStreamEvent {
  return { type, data } as HandleMessageStreamEvent;
}

function signedFormRequest(path: string, params: URLSearchParams): Request {
  const url = `https://example.com${path}`;
  const signature = signTwilioRequest({ authToken: AUTH_TOKEN, params, url });
  return new Request(url, {
    body: params,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature,
    },
    method: "POST",
  });
}

function signedGetRequest(path: string, params: URLSearchParams): Request {
  const url = new URL(`https://example.com${path}`);
  for (const [key, value] of params) {
    url.searchParams.append(key, value);
  }
  const signature = signTwilioRequest({
    authToken: AUTH_TOKEN,
    params: new URLSearchParams(),
    url: url.toString(),
  });
  return new Request(url, {
    headers: {
      "x-twilio-signature": signature,
    },
    method: "GET",
  });
}

async function firePost(
  channel: unknown,
  path: string,
  params: URLSearchParams,
): Promise<{
  response: Response;
  send: ReturnType<typeof vi.fn>;
  waitUntil: ReturnType<typeof vi.fn>;
}> {
  const compiled = asCompiled(channel);
  const post = compiled.routes.find((r) => r.method === "POST" && r.path === path);
  if (!post || !isHttpRouteDefinition(post)) {
    throw new Error(`Expected Twilio channel to define POST ${path}.`);
  }
  const send = vi.fn().mockResolvedValue({ continuationToken: "ct", id: "s1" });
  const waitUntil = vi.fn();

  const response = await post.handler(signedFormRequest(path, params), {
    getSession: vi.fn() as any,
    params: {},
    requestIp: null,
    send,
    waitUntil,
  } as any);

  let drained = 0;
  while (drained < waitUntil.mock.calls.length) {
    const pending = waitUntil.mock.calls.slice(drained).map(([task]) => task as Promise<unknown>);
    drained = waitUntil.mock.calls.length;
    await Promise.allSettled(pending);
  }

  return { response, send, waitUntil };
}

async function fireGet(
  channel: unknown,
  path: string,
  params: URLSearchParams,
): Promise<{
  response: Response;
  send: ReturnType<typeof vi.fn>;
  waitUntil: ReturnType<typeof vi.fn>;
}> {
  const compiled = asCompiled(channel);
  const get = compiled.routes.find((r) => r.method === "GET" && r.path === path);
  if (!get || !isHttpRouteDefinition(get)) {
    throw new Error(`Expected Twilio channel to define GET ${path}.`);
  }
  const send = vi.fn().mockResolvedValue({ continuationToken: "ct", id: "s1" });
  const waitUntil = vi.fn();

  const response = await get.handler(signedGetRequest(path, params), {
    getSession: vi.fn() as any,
    params: {},
    requestIp: null,
    send,
    waitUntil,
  } as any);

  let drained = 0;
  while (drained < waitUntil.mock.calls.length) {
    const pending = waitUntil.mock.calls.slice(drained).map(([task]) => task as Promise<unknown>);
    drained = waitUntil.mock.calls.length;
    await Promise.allSettled(pending);
  }

  return { response, send, waitUntil };
}

describe("twilioChannel() inbound text pipeline", () => {
  const ORIGINAL_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

  beforeEach(() => {
    process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
  });

  afterAll(() => {
    if (ORIGINAL_AUTH_TOKEN === undefined) {
      delete process.env.TWILIO_AUTH_TOKEN;
    } else {
      process.env.TWILIO_AUTH_TOKEN = ORIGINAL_AUTH_TOKEN;
    }
  });

  it("mounts message, voice, and transcription routes below the base route", () => {
    const channel = twilioChannel({ allowFrom: "*", route: "/twilio" });
    expect(channel.routes.map((route) => ({ method: route.method, path: route.path }))).toEqual([
      { method: "GET", path: "/twilio/messages" },
      { method: "POST", path: "/twilio/messages" },
      { method: "GET", path: "/twilio/voice" },
      { method: "POST", path: "/twilio/voice" },
      { method: "GET", path: "/twilio/voice/transcription" },
      { method: "POST", path: "/twilio/voice/transcription" },
    ]);
  });

  it("requires an explicit allowFrom policy", () => {
    expect(() => twilioChannel(undefined as any)).toThrow(
      'twilioChannel requires allowFrom. Use allowFrom: "*" to allow all numbers.',
    );
  });

  it("dispatches verified inbound text with the from/to pair as continuation token", async () => {
    const channel = twilioChannel({ allowFrom: "*" });
    const params = new URLSearchParams({
      Body: "hello",
      From: "+15551234567",
      MessageSid: "SM123",
      To: "+15557654321",
    });

    const { response, send } = await firePost(channel, "/eve/v1/twilio/messages", params);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<Response></Response>");
    expect(send).toHaveBeenCalledTimes(1);
    const [payload, options] = send.mock.calls[0]!;
    const { message, context } = payload as { message: string; context: string[] };
    const contextBlock = context[0]!;
    expect(contextBlock).toContain("<twilio_context>");
    expect(contextBlock).toContain("channel: text");
    expect(contextBlock).toContain("response_medium: sms");
    expect(contextBlock).toContain("Reply for SMS in plain text.");
    expect(contextBlock).toContain("avoid Markdown formatting");
    expect(message).toBe("hello");
    expect(options).toMatchObject({
      auth: {
        authenticator: "twilio-webhook",
        principalId: "twilio:+15551234567",
      },
      continuationToken: "+15551234567:+15557654321",
      state: {
        from: "+15551234567",
        lastMessageSid: "SM123",
        to: "+15557654321",
      },
    });
  });

  it("dispatches verified GET inbound text webhooks", async () => {
    const channel = twilioChannel({ allowFrom: "*" });
    const params = new URLSearchParams({
      Body: "hello from get",
      From: "+15551234567",
      MessageSid: "SM123",
      To: "+15557654321",
    });

    const { response, send } = await fireGet(channel, "/eve/v1/twilio/messages", params);

    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    const [payload, options] = send.mock.calls[0]!;
    expect(payload).toMatchObject({ message: "hello from get" });
    expect(options).toMatchObject({
      continuationToken: "+15551234567:+15557654321",
      state: {
        from: "+15551234567",
        lastMessageSid: "SM123",
        to: "+15557654321",
      },
    });
  });

  it("passes inbound media metadata from Twilio message webhooks", async () => {
    const onText = vi.fn((_ctx: TwilioContext, _message: TwilioTextMessage) => ({ auth: null }));
    const channel = twilioChannel({ allowFrom: "*", onText });
    const params = new URLSearchParams({
      Body: "see attached",
      From: "+15551234567",
      MediaContentType0: "image/png",
      MediaUrl0: "https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/MM123/Media/ME123",
      NumMedia: "1",
      To: "+15557654321",
    });

    await firePost(channel, "/eve/v1/twilio/messages", params);

    expect(onText).toHaveBeenCalledTimes(1);
    expect(onText.mock.calls[0]![1]).toMatchObject({
      body: "see attached",
      media: [
        {
          contentType: "image/png",
          url: "https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/MM123/Media/ME123",
        },
      ],
    });
  });

  it("drops inbound text when the sender is not in allowFrom", async () => {
    const channel = twilioChannel({ allowFrom: ["+15550000000"] });
    const params = new URLSearchParams({
      Body: "hello",
      From: "+15551234567",
      To: "+15557654321",
    });

    const { response, send } = await firePost(channel, "/eve/v1/twilio/messages", params);

    expect(response.status).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });

  it("accepts inbound text when allowFrom is a single sender string", async () => {
    const channel = twilioChannel({ allowFrom: "+15551234567" });
    const params = new URLSearchParams({
      Body: "hello",
      From: "+15551234567",
      To: "+15557654321",
    });

    const { response, send } = await firePost(channel, "/eve/v1/twilio/messages", params);

    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("resolves allowFrom dynamically for inbound text", async () => {
    const allowFrom = vi.fn(async () => ["+15551234567"]);
    const channel = twilioChannel({ allowFrom });
    const params = new URLSearchParams({
      Body: "hello",
      From: "+15551234567",
      To: "+15557654321",
    });

    const { response, send } = await firePost(channel, "/eve/v1/twilio/messages", params);

    expect(response.status).toBe(200);
    expect(allowFrom).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch when onText returns null", async () => {
    const channel = twilioChannel({ allowFrom: "*", onText: () => null });
    const params = new URLSearchParams({
      Body: "hello",
      From: "+15551234567",
      To: "+15557654321",
    });

    const { send } = await firePost(channel, "/eve/v1/twilio/messages", params);

    expect(send).not.toHaveBeenCalled();
  });

  it("rejects inbound text with a bad signature", async () => {
    const channel = twilioChannel({ allowFrom: "*" });
    const compiled = asCompiled(channel);
    const post = compiled.routes.find((r) => r.path === "/eve/v1/twilio/messages");
    if (!post || !isHttpRouteDefinition(post)) {
      throw new Error("Expected Twilio messages route.");
    }
    const send = vi.fn();
    const response = await post.handler(
      new Request("https://example.com/eve/v1/twilio/messages", {
        body: new URLSearchParams({ Body: "hello", From: "+15551234567" }),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-twilio-signature": "wrong",
        },
        method: "POST",
      }),
      {
        getSession: vi.fn() as any,
        params: {},
        requestIp: null,
        send,
        waitUntil: vi.fn(),
      } as any,
    );

    expect(response.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps the same sender separate across different Twilio receiver numbers", async () => {
    const channel = twilioChannel({ allowFrom: "*" });

    const first = await firePost(
      channel,
      "/eve/v1/twilio/messages",
      new URLSearchParams({
        Body: "first",
        From: "+15551234567",
        To: "+15550000001",
      }),
    );
    const second = await firePost(
      channel,
      "/eve/v1/twilio/messages",
      new URLSearchParams({
        Body: "second",
        From: "+15551234567",
        To: "+15550000002",
      }),
    );

    expect(first.send.mock.calls[0]![1]).toMatchObject({
      continuationToken: "+15551234567:+15550000001",
      state: { from: "+15551234567", to: "+15550000001" },
    });
    expect(second.send.mock.calls[0]![1]).toMatchObject({
      continuationToken: "+15551234567:+15550000002",
      state: { from: "+15551234567", to: "+15550000002" },
    });
  });
});

describe("twilioChannel() voice pipeline", () => {
  const ORIGINAL_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

  beforeEach(() => {
    process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
  });

  afterAll(() => {
    if (ORIGINAL_AUTH_TOKEN === undefined) {
      delete process.env.TWILIO_AUTH_TOKEN;
    } else {
      process.env.TWILIO_AUTH_TOKEN = ORIGINAL_AUTH_TOKEN;
    }
  });

  it("accepts an inbound call by returning Gather TwiML", async () => {
    const channel = twilioChannel({
      allowFrom: "*",
      publicBaseUrl: "https://public.example.com",
    });
    const params = new URLSearchParams({
      CallSid: "CA123",
      From: "+15551234567",
      To: "+15557654321",
    });

    const { response, send } = await firePost(channel, "/eve/v1/twilio/voice", params);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('<Gather input="speech"');
    expect(body).toContain('action="https://public.example.com/eve/v1/twilio/voice/transcription"');
    expect(send).not.toHaveBeenCalled();
  });

  it("uses onVoice result fields when answering an inbound call", async () => {
    const onVoice = vi.fn(() => ({
      language: "en-US",
      prompt: "How can I help?",
      speechModel: "phone_call",
      speechTimeout: "2",
      voice: "Polly.Joanna-Neural",
    }));
    const channel = twilioChannel({
      allowFrom: "*",
      onVoice,
      publicBaseUrl: "https://public.example.com",
    });
    const params = new URLSearchParams({
      CallSid: "CA123",
      From: "+15551234567",
      To: "+15557654321",
    });

    const { response } = await firePost(channel, "/eve/v1/twilio/voice", params);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(onVoice).toHaveBeenCalledTimes(1);
    expect(body).toContain('language="en-US"');
    expect(body).toContain('speechModel="phone_call"');
    expect(body).toContain('speechTimeout="2"');
    expect(body).toContain('<Say voice="Polly.Joanna-Neural" language="en-US">');
    expect(body).toContain("How can I help?");
  });

  it("rejects an inbound call when onVoice returns null", async () => {
    const channel = twilioChannel({
      allowFrom: "*",
      onVoice: () => null,
      publicBaseUrl: "https://public.example.com",
    });
    const params = new URLSearchParams({
      CallSid: "CA123",
      From: "+15551234567",
      To: "+15557654321",
    });

    const { response, send } = await firePost(channel, "/eve/v1/twilio/voice", params);

    expect(response.status).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });

  it("accepts an inbound call with a dynamic single-number allowFrom resolver", async () => {
    const allowFrom = vi.fn(() => "+15551234567");
    const channel = twilioChannel({ allowFrom, publicBaseUrl: "https://public.example.com" });
    const params = new URLSearchParams({
      CallSid: "CA123",
      From: "+15551234567",
      To: "+15557654321",
    });

    const { response, send } = await firePost(channel, "/eve/v1/twilio/voice", params);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("<Gather");
    expect(allowFrom).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it("dispatches a Gather SpeechResult as voice transcription", async () => {
    const channel = twilioChannel({ allowFrom: "*" });
    const params = new URLSearchParams({
      CallSid: "CA123",
      From: "+15551234567",
      SpeechResult: "book a table",
      To: "+15557654321",
    });

    const { response, send } = await firePost(
      channel,
      "/eve/v1/twilio/voice/transcription",
      params,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Thanks. I&apos;ll follow up by text.");
    expect(send).toHaveBeenCalledTimes(1);
    const [payload, options] = send.mock.calls[0]!;
    const { message, context } = payload as { message: string; context: string[] };
    const contextBlock = context[0]!;
    expect(contextBlock).toContain("channel: voice");
    expect(contextBlock).toContain("response_medium: sms");
    expect(contextBlock).toContain("Reply for SMS in plain text.");
    expect(message).toBe("book a table");
    expect(options).toMatchObject({
      continuationToken: "+15551234567:+15557654321",
      state: {
        from: "+15551234567",
        lastCallSid: "CA123",
        lastMessageSid: null,
        to: "+15557654321",
      },
    });
  });

  it("ignores real-time partial transcription callbacks", async () => {
    const channel = twilioChannel({ allowFrom: "*" });
    const params = new URLSearchParams({
      CallSid: "CA123",
      Final: "false",
      From: "+15551234567",
      TranscriptionData: JSON.stringify({ transcript: "partial words" }),
      To: "+15557654321",
    });

    const { response, send } = await firePost(
      channel,
      "/eve/v1/twilio/voice/transcription",
      params,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<Gather");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("twilioChannel() default event handlers", () => {
  const ORIGINAL_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
  const ORIGINAL_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

  beforeEach(() => {
    process.env.TWILIO_ACCOUNT_SID = "AC123";
    process.env.TWILIO_AUTH_TOKEN = "token";
  });

  afterAll(() => {
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

  it("message.completed sends an SMS via Twilio Messages API", async () => {
    const fetchCalls: Array<[string | URL | Request, RequestInit | undefined]> = [];
    const fetchMock: typeof fetch = async (input: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push([input, init]);
      return new Response(JSON.stringify({ sid: "SM999" }), {
        headers: { "content-type": "application/json" },
      });
    };
    const adapter = withState(
      getAdapter(
        twilioChannel({
          allowFrom: "*",
          api: { apiBaseUrl: "https://twilio.test", fetch: fetchMock },
          messaging: { from: "+15557654321" },
        }),
      ),
      {
        from: "+15551234567",
        lastCallSid: null,
        lastMessageSid: "SM123",
        to: "+15557654321",
      },
    );
    const ctx = buildAdapterContext(adapter, stubAccessor());

    await callEvent(
      adapter,
      makeEvent("message.completed", {
        finishReason: "stop",
        message: "Hello from the agent",
        sequence: 0,
        stepIndex: 0,
        turnId: "t1",
      }),
      ctx,
    );

    expect(fetchCalls).toHaveLength(1);
    const [url, init] = fetchCalls[0]!;
    expect(String(url)).toBe("https://twilio.test/2010-04-01/Accounts/AC123/Messages.json");
    const body = new URLSearchParams(String((init as RequestInit).body));
    expect(Object.fromEntries(body)).toMatchObject({
      Body: "Hello from the agent",
      From: "+15557654321",
      To: "+15551234567",
    });
  });

  it("receive starts a phone-pair session with an explicit continuation token", async () => {
    const channel = twilioChannel({
      allowFrom: "*",
      messaging: { from: "+15557654321" },
    });
    const send = vi.fn().mockResolvedValue({ continuationToken: "+15551234567", id: "s1" });

    await channel.receive!(
      {
        target: { phoneNumber: "+15551234567" },
        auth: null,
        message: "start",
      },
      { send },
    );

    expect(send).toHaveBeenCalledWith("start", {
      auth: null,
      continuationToken: "+15551234567:+15557654321",
      state: {
        from: "+15551234567",
        lastCallSid: null,
        lastMessageSid: null,
        to: "+15557654321",
      },
    });
  });
});
