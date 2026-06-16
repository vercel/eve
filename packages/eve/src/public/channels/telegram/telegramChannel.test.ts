import { afterEach, describe, expect, it, vi } from "vitest";

import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler, type ChannelAdapter } from "#channel/adapter.js";
import { isCompiledChannel, type CompiledChannel } from "#channel/compiled-channel.js";
import { isHttpRouteDefinition } from "#channel/routes.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import { telegramChannel, type TelegramChannelState } from "#public/channels/telegram/index.js";

const SECRET = "telegram-secret";

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

function signedRequest(body: string): Request {
  return new Request("https://example.com/eve/v1/telegram", {
    body,
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": SECRET,
    },
    method: "POST",
  });
}

function fakeTelegramFetch(): typeof fetch {
  return async () => new Response(JSON.stringify({ ok: true, result: true }));
}

async function firePost(
  channel: unknown,
  body: unknown,
): Promise<{
  readonly response: Response;
  readonly send: ReturnType<typeof vi.fn>;
  readonly waitUntil: ReturnType<typeof vi.fn>;
}> {
  const compiled = asCompiled(channel);
  const post = compiled.routes.find((route) => route.method === "POST");
  if (!post || !isHttpRouteDefinition(post)) {
    throw new Error("Expected telegram channel to define a POST route.");
  }
  const send = vi.fn().mockResolvedValue({ continuationToken: "ct", id: "s1" });
  const waitUntil = vi.fn();

  const response = await post.handler(signedRequest(JSON.stringify(body)), {
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

function captureAccessor(initialContinuationToken: string): {
  readonly accessor: any;
  readonly writes: Array<[string, unknown]>;
} {
  const writes: Array<[string, unknown]> = [];
  let continuationToken = initialContinuationToken;
  return {
    accessor: {
      get: (key: { name: string }) =>
        key.name === "eve.continuationToken" ? continuationToken : undefined,
      set: (key: { name: string }, value: unknown | ((current: unknown) => unknown)) => {
        const next =
          typeof value === "function" ? (value as (current: unknown) => unknown)(undefined) : value;
        if (key.name === "eve.continuationToken") continuationToken = String(next);
        writes.push([key.name, next]);
        return next;
      },
    },
    writes,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("telegramChannel() inbound route", () => {
  it("mounts the default Telegram webhook route", () => {
    expect(
      telegramChannel().routes.map((route) => ({ method: route.method, path: route.path })),
    ).toEqual([{ method: "POST", path: "/eve/v1/telegram" }]);
  });

  it("dispatches verified private messages with Telegram auth and chat-wide token", async () => {
    const channel = telegramChannel({
      api: { fetch: fakeTelegramFetch() },
      credentials: { botToken: "bot-token", webhookSecretToken: SECRET },
    });

    const { response, send } = await firePost(channel, {
      update_id: 1,
      message: {
        message_id: 10,
        from: { id: 42, is_bot: false, first_name: "Ada", username: "ada" },
        chat: { id: 42, type: "private" },
        text: "hello",
      },
    });

    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    const [payload, options] = send.mock.calls[0]!;
    expect((payload as { context: string[] }).context[0]).toContain("<telegram_context>");
    expect(String((payload as { message: string }).message)).toContain("hello");
    expect(options).toMatchObject({
      auth: {
        authenticator: "telegram-webhook",
        principalId: "telegram:42",
      },
      continuationToken: "42::",
      state: {
        chatId: "42",
        chatType: "private",
        conversationId: null,
      },
    });
  });

  it("gates group messages to commands, mentions, and replies to the bot", async () => {
    const channel = telegramChannel({
      api: { fetch: fakeTelegramFetch() },
      botUsername: "testbot",
      credentials: { botToken: "bot-token", webhookSecretToken: SECRET },
    });

    const ignored = await firePost(channel, {
      message: {
        message_id: 10,
        from: { id: 42, is_bot: false },
        chat: { id: -1001, type: "supergroup" },
        text: "hello everyone",
      },
    });
    expect(ignored.send).not.toHaveBeenCalled();

    const mentioned = await firePost(channel, {
      message: {
        message_id: 11,
        from: { id: 42, is_bot: false },
        chat: { id: -1001, type: "supergroup" },
        text: "/ask@testbot hello",
      },
    });
    expect(mentioned.send).toHaveBeenCalledTimes(1);
    expect(mentioned.send.mock.calls[0]![1]).toMatchObject({
      continuationToken: "-1001::11",
    });
  });

  it("delivers Telegram callback queries as compact HITL input responses", async () => {
    const channel = telegramChannel({
      api: { fetch: fakeTelegramFetch() },
      credentials: { botToken: "bot-token", webhookSecretToken: SECRET },
    });

    const { send } = await firePost(channel, {
      callback_query: {
        id: "cb1",
        from: { id: 42, is_bot: false },
        data: "eve:0",
        message: {
          message_id: 55,
          chat: { id: -1001, type: "supergroup" },
        },
      },
    });

    expect(send).toHaveBeenCalledWith(
      { inputResponses: [{ optionId: "selected", requestId: "telegram_callback:eve:0" }] },
      expect.objectContaining({
        auth: null,
        continuationToken: "-1001::55",
      }),
    );
  });

  it("marks replies to bot messages as possible freeform HITL answers", async () => {
    const channel = telegramChannel({
      api: { fetch: fakeTelegramFetch() },
      credentials: { botToken: "bot-token", webhookSecretToken: SECRET },
    });

    const { send } = await firePost(channel, {
      message: {
        message_id: 56,
        from: { id: 42, is_bot: false },
        chat: { id: 42, type: "private" },
        reply_to_message: {
          message_id: 55,
          from: { id: 99, is_bot: true, username: "testbot" },
          chat: { id: 42, type: "private" },
        },
        text: "approved",
      },
    });

    const [payload] = send.mock.calls[0]!;
    expect(payload).toMatchObject({
      inputResponses: [{ requestId: "telegram_reply:55", text: "approved" }],
    });
    expect(String((payload as { message: string }).message)).toContain("approved");
  });

  it("rejects requests with invalid webhook verification", async () => {
    const channel = telegramChannel({ credentials: { webhookSecretToken: SECRET } });
    const compiled = asCompiled(channel);
    const post = compiled.routes.find((route) => route.method === "POST");
    if (!post || !isHttpRouteDefinition(post)) {
      throw new Error("Expected telegram channel to define a POST route.");
    }
    const send = vi.fn();

    const response = await post.handler(
      new Request("https://example.com/eve/v1/telegram", {
        body: "{}",
        headers: { "x-telegram-bot-api-secret-token": "wrong" },
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
});

describe("telegramChannel() deliver hook", () => {
  it("maps compact callback and freeform reply responses through durable state", async () => {
    const adapter = withState(getAdapter(telegramChannel()), {
      hitlCallbacks: {
        "eve:0": { optionId: "approve", requestId: "call_1" },
      },
      pendingFreeformReplies: {
        "55": "call_2",
      },
    });
    const ctx = buildAdapterContext(adapter, { get: () => undefined, set: () => {} } as any);

    expect(
      await adapter.deliver!(
        {
          inputResponses: [
            { optionId: "selected", requestId: "telegram_callback:eve:0" },
            { requestId: "telegram_reply:55", text: "because" },
          ],
        },
        ctx,
      ),
    ).toEqual({
      inputResponses: [
        { optionId: "approve", requestId: "call_1" },
        { requestId: "call_2", text: "because" },
      ],
      context: undefined,
    });
  });

  it("falls back to a normal message when a reply is not a pending freeform answer", async () => {
    const adapter = getAdapter(telegramChannel());
    const ctx = buildAdapterContext(adapter, { get: () => undefined, set: () => {} } as any);

    expect(
      await adapter.deliver!(
        {
          inputResponses: [{ requestId: "telegram_reply:55", text: "hello" }],
          message: "hello",
        },
        ctx,
      ),
    ).toEqual({ message: "hello", context: undefined });
  });
});

describe("telegramChannel() default event handlers", () => {
  it("input.requested posts an inline keyboard and stores compact callback mappings", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, result: { message_id: 50, chat: { id: 42 } } })),
      );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = withState(
      getAdapter(telegramChannel({ credentials: { botToken: "bot-token" } })),
      { chatId: "42", chatType: "private" },
    );
    const ctx = buildAdapterContext(adapter, { get: () => undefined, set: () => {} } as any);

    await callEvent(
      adapter,
      makeEvent("input.requested", {
        requests: [
          {
            action: { callId: "call_1", input: {}, kind: "tool-call", toolName: "ask_question" },
            options: [{ id: "approve", label: "Approve" }],
            prompt: "Approve?",
            requestId: "call_1",
          },
        ],
        sequence: 0,
        stepIndex: 0,
        turnId: "t1",
      }),
      ctx,
    );

    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(body.reply_markup.inline_keyboard[0][0]).toEqual({
      callback_data: "eve:0",
      text: "Approve",
    });
    expect(ctx.state.hitlCallbacks).toEqual({
      "eve:0": { optionId: "approve", requestId: "call_1" },
    });
  });

  it("freeform input requests register the prompt message id", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, result: { message_id: 51, chat: { id: 42 } } })),
      );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = withState(
      getAdapter(telegramChannel({ credentials: { botToken: "bot-token" } })),
      { chatId: "42", chatType: "private" },
    );
    const ctx = buildAdapterContext(adapter, { get: () => undefined, set: () => {} } as any);

    await callEvent(
      adapter,
      makeEvent("input.requested", {
        requests: [
          {
            action: { callId: "call_1", input: {}, kind: "tool-call", toolName: "ask_question" },
            allowFreeform: true,
            prompt: "Explain",
            requestId: "call_1",
          },
        ],
        sequence: 0,
        stepIndex: 0,
        turnId: "t1",
      }),
      ctx,
    );

    expect(ctx.state.pendingFreeformReplies).toEqual({ "51": "call_1" });
  });

  it("group message posts re-key the session to the posted message id", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, result: { message_id: 77, chat: { id: -1001 } } })),
      );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = withState(
      getAdapter(telegramChannel({ credentials: { botToken: "bot-token" } })),
      { chatId: "-1001", chatType: "supergroup", conversationId: "10" },
    );
    const { accessor, writes } = captureAccessor("telegram:-1001::10");
    const ctx = buildAdapterContext(adapter, accessor);

    await callEvent(
      adapter,
      makeEvent("message.completed", {
        finishReason: "stop",
        message: "hello",
        sequence: 0,
        stepIndex: 0,
        turnId: "t1",
      }),
      ctx,
    );

    expect(writes).toContainEqual(["eve.continuationToken", "telegram:-1001::77"]);
    expect(ctx.state.conversationId).toBe("77");
  });
});

describe("telegramChannel().receive", () => {
  it("starts a proactive session and anchors initialMessage under Telegram's message id", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, result: { message_id: 88, chat: { id: 42 } } })),
      );
    const channel = asCompiled<TelegramChannelState>(
      telegramChannel({
        api: { apiBaseUrl: "https://telegram.example", fetch: fetchMock },
        credentials: { botToken: "bot-token" },
      }),
    );
    const send = vi.fn().mockResolvedValue({ continuationToken: "ct", id: "s1" });

    await channel.receive!(
      {
        target: { chatId: 42, initialMessage: "Starting" },
        auth: null,
        message: "run",
      },
      { send },
    );

    expect(send).toHaveBeenCalledWith(
      "run",
      expect.objectContaining({
        continuationToken: "42::88",
        state: expect.objectContaining({ chatId: "42", conversationId: "88" }),
      }),
    );
  });

  it("requires chatId and rejects conversationId plus initialMessage", async () => {
    const channel = asCompiled<TelegramChannelState>(telegramChannel());
    const send = vi.fn();

    await expect(
      channel.receive!({ target: {}, auth: null, message: "run" }, { send }),
    ).rejects.toThrow(/requires target.chatId/);
    await expect(
      channel.receive!(
        {
          target: { chatId: 42, conversationId: "1", initialMessage: "x" },
          auth: null,
          message: "run",
        },
        { send },
      ),
    ).rejects.toThrow(/mutually exclusive/);
  });
});
