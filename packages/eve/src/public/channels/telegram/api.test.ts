import { describe, expect, it, vi } from "vitest";

import {
  callTelegramApi,
  sendTelegramChatAction,
  sendTelegramMessage,
  splitTelegramMessageText,
  telegramContinuationToken,
} from "#public/channels/telegram/api.js";

describe("telegramContinuationToken", () => {
  it("builds a channel-local token from chat, topic, and conversation ids", () => {
    expect(telegramContinuationToken({ chatId: 123 })).toBe("123::");
    expect(
      telegramContinuationToken({
        chatId: "-1001",
        conversationId: 88,
        messageThreadId: 7,
      }),
    ).toBe("-1001:7:88");
  });
});

describe("callTelegramApi", () => {
  it("posts JSON to the bot API with the resolved token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: true }), {
        headers: { "content-type": "application/json" },
      }),
    );

    await callTelegramApi({
      apiBaseUrl: "https://telegram.example",
      body: { chat_id: "C1", text: "hello" },
      botToken: "bot-token",
      fetch: fetchMock,
      method: "sendMessage",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://telegram.example/botbot-token/sendMessage",
      expect.objectContaining({
        body: JSON.stringify({ chat_id: "C1", text: "hello" }),
        method: "POST",
      }),
    );
  });

  it("keeps the Telegram token delimiter unescaped in the API path", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    await callTelegramApi({
      apiBaseUrl: "https://telegram.example",
      botToken: "123456:ABCDEF",
      fetch: fetchMock,
      method: "getMe",
    });

    expect(fetchMock.mock.calls[0]![0]).toBe("https://telegram.example/bot123456:ABCDEF/getMe");
  });
});

describe("sendTelegramMessage", () => {
  it("extracts the posted message id and chat id from Telegram's response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          result: { message_id: 42, chat: { id: -1001 } },
        }),
      ),
    );

    const posted = await sendTelegramMessage({
      body: { text: "hello" },
      chatId: -1001,
      credentials: { botToken: "bot-token" },
      fetch: fetchMock,
    });

    expect(posted).toMatchObject({ chatId: "-1001", id: "42" });
  });
});

describe("sendTelegramChatAction", () => {
  it("passes message_thread_id when supplied", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    await sendTelegramChatAction({
      action: "typing",
      chatId: "-1001",
      credentials: { botToken: "bot-token" },
      fetch: fetchMock,
      messageThreadId: 10,
    });

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      action: "typing",
      chat_id: "-1001",
      message_thread_id: 10,
    });
  });
});

describe("splitTelegramMessageText", () => {
  it("keeps short content intact and splits long content at Telegram's cap", () => {
    expect(splitTelegramMessageText("short")).toEqual(["short"]);

    const chunks = splitTelegramMessageText(`${"a".repeat(4090)}\n${"b".repeat(20)}`);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.length).toBeLessThanOrEqual(4096);
    expect(chunks[1]).toBe("bbbbbbbbbbbbbbbbbbbb");
  });
});
