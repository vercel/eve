import { afterEach, describe, expect, it, vi } from "vitest";

import { Message } from "#compiled/chat/index.js";
import {
  linqQuotedMessage,
  rehydrateLinqAttachment,
} from "#public/channels/linq/inboundContent.js";

afterEach(() => vi.restoreAllMocks());

describe("Linq attachment downloads", () => {
  it.each(["http://files.example/photo.png", "https://localhost/photo.png"])(
    "refuses a non-public-HTTPS destination without fetching: %s",
    async (url) => {
      const fetchMock = vi.spyOn(globalThis, "fetch");
      const attachment = rehydrateLinqAttachment({ type: "image", url });

      await expect(attachment.fetchData!()).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("preserves the upload-limit explanation for oversized downloads", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        headers: { "content-length": String(25 * 1024 * 1024 + 1) },
      }),
    );
    const attachment = rehydrateLinqAttachment({
      type: "image",
      url: "https://files.example/photo.png",
    });

    await expect(attachment.fetchData!()).rejects.toMatchObject({
      name: "EveAttachmentError",
      message: "it is over the 25 MB upload limit.",
    });
  });

  it("downloads public HTTPS attachments as bytes without credentials", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("photo"));
    const attachment = rehydrateLinqAttachment({
      type: "image",
      url: "https://files.example/photo.png",
    });

    await expect(attachment.fetchData!()).resolves.toEqual(Buffer.from("photo"));
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).has("authorization")).toBe(false);
  });
});

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
