import { describe, expect, it } from "vitest";

import {
  formatTelegramContextBlock,
  parseTelegramUpdate,
} from "#public/channels/telegram/inbound.js";

describe("parseTelegramUpdate", () => {
  it("parses inbound messages with text, actor, reply context, and largest photo", () => {
    const update = parseTelegramUpdate({
      update_id: 1,
      message: {
        message_id: 10,
        message_thread_id: 7,
        from: { id: 42, is_bot: false, first_name: "Ada", username: "ada" },
        chat: { id: -1001, type: "supergroup", title: "Ops" },
        text: "/ask@testbot hello",
        reply_to_message: {
          message_id: 9,
          from: { id: 99, is_bot: true, username: "testbot" },
          chat: { id: -1001, type: "supergroup", title: "Ops" },
        },
        photo: [
          { file_id: "small", file_unique_id: "u1", width: 10, height: 10, file_size: 100 },
          { file_id: "large", file_unique_id: "u2", width: 20, height: 20, file_size: 400 },
        ],
      },
    });

    expect(update).toMatchObject({
      kind: "message",
      message: {
        messageId: "10",
        messageThreadId: 7,
        text: "/ask@testbot hello",
        chat: { id: "-1001", type: "supergroup", title: "Ops" },
        from: { id: "42", username: "ada" },
        replyToMessage: { messageId: "9", from: { isBot: true } },
        attachments: [{ fileId: "large", kind: "photo", mediaType: "image/jpeg" }],
      },
    });
  });

  it("parses document messages and callback queries", () => {
    const message = parseTelegramUpdate({
      message: {
        message_id: 11,
        chat: { id: 42, type: "private" },
        document: {
          file_id: "doc-id",
          file_name: "report.pdf",
          mime_type: "application/pdf",
          file_size: 123,
        },
      },
    });
    expect(message).toMatchObject({
      kind: "message",
      message: {
        attachments: [
          {
            fileId: "doc-id",
            fileName: "report.pdf",
            kind: "document",
            mediaType: "application/pdf",
            size: 123,
          },
        ],
      },
    });

    const callback = parseTelegramUpdate({
      callback_query: {
        id: "cb1",
        from: { id: 42, is_bot: false, username: "ada" },
        data: "eve:0",
        message: {
          message_id: 12,
          chat: { id: 42, type: "private" },
        },
      },
    });
    expect(callback).toMatchObject({
      kind: "callback_query",
      callbackQuery: {
        data: "eve:0",
        from: { id: "42", username: "ada" },
        id: "cb1",
        message: { messageId: "12", chat: { id: "42" } },
      },
    });
  });

  it("returns null for unsupported or incomplete updates", () => {
    expect(parseTelegramUpdate({ edited_message: {} })).toBeNull();
    expect(parseTelegramUpdate({ message: { message_id: 1 } })).toBeNull();
  });
});

describe("Telegram context rendering", () => {
  it("renders a deterministic context block", () => {
    expect(
      formatTelegramContextBlock({
        botUsername: "testbot",
        chatId: "-1001",
        chatTitle: "Ops",
        chatType: "supergroup",
        messageId: "10",
        messageThreadId: 7,
        userId: "42",
        username: "ada",
      }),
    ).toContain("<telegram_context>\nresponse_medium: telegram");
  });

  it("renders chat and actor identity into the block", () => {
    const block = formatTelegramContextBlock({
      chatId: "42",
      chatType: "private",
      messageId: "1",
      userId: "7",
      username: "ada",
    });

    expect(block).toContain("<telegram_context>");
    expect(block).toContain("chat_id: 42");
    expect(block).toContain("user_id: 7");
    expect(block).toContain("username: ada");
  });
});
