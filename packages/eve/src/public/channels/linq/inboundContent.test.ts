import { describe, expect, it, vi } from "vitest";

import { Message } from "#compiled/chat/index.js";
import { linqQuotedMessage } from "#public/channels/linq/inboundContent.js";

function message(raw: unknown, overrides: { isMe?: boolean; text?: string } = {}): Message {
  return new Message({
    attachments: [],
    formatted: { type: "root", children: [] },
    metadata: { dateSent: new Date(0), edited: false },
    author: {
      fullName: "User",
      isBot: false,
      isMe: overrides.isMe ?? false,
      userId: "user",
      userName: "user",
    },
    id: "message-id",
    raw,
    text: overrides.text ?? "hello",
    threadId: "linq:chat-id",
  });
}

describe("linqQuotedMessage", () => {
  it("returns nothing for a message that is not a reply", async () => {
    const fetchMessage = vi.fn();
    await expect(linqQuotedMessage({ fetchMessage }, message({ reply_to: null }))).resolves.toBe(
      undefined,
    );
    expect(fetchMessage).not.toHaveBeenCalled();
  });

  it("fetches the replied-to message's text and author", async () => {
    const fetchMessage = vi.fn(async () => message({}, { isMe: true, text: "Dinner at 7?" }));
    const reply = message({ reply_to: { message_id: "target-id", part_index: 0 } });

    await expect(linqQuotedMessage({ fetchMessage }, reply)).resolves.toEqual({
      fromAgent: true,
      id: "target-id",
      text: "Dinner at 7?",
    });
    expect(fetchMessage).toHaveBeenCalledWith("linq:chat-id", "target-id");
  });

  it("reports the reply without text when the lookup fails", async () => {
    const fetchMessage = vi.fn(async () => {
      throw new Error("Linq API unavailable");
    });
    const reply = message({ reply_to: { message_id: "target-id" } });

    await expect(linqQuotedMessage({ fetchMessage }, reply)).resolves.toEqual({ id: "target-id" });
  });

  it("stops waiting for a slow lookup", async () => {
    vi.useFakeTimers();
    try {
      const fetchMessage = vi.fn(() => new Promise<Message | null>(() => {}));
      const quoted = linqQuotedMessage(
        { fetchMessage },
        message({ reply_to: { message_id: "target-id" } }),
      );
      await vi.advanceTimersByTimeAsync(3000);
      await expect(quoted).resolves.toEqual({ id: "target-id" });
    } finally {
      vi.useRealTimers();
    }
  });
});
