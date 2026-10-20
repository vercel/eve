import { describe, expect, it } from "vitest";

import { Message, parseMarkdown } from "#compiled/chat/index.js";
import { messageContentOf } from "#public/channels/chat-sdk/message-content.js";

describe("messageContentOf", () => {
  it("notes an attachment without a download in place, keeping the other parts", () => {
    const mixed = new Message({
      attachments: [
        { name: "pasted", type: "image" },
        {
          mimeType: "application/pdf",
          name: "a.pdf",
          type: "file",
          url: "https://example.com/a.pdf",
        },
      ],
      author: {
        fullName: "Test User",
        isBot: false,
        isMe: false,
        userId: "user-1",
        userName: "alice",
      },
      formatted: parseMarkdown("see both"),
      id: "message-3",
      isMention: true,
      metadata: { dateSent: new Date("2026-01-01T00:00:00.000Z"), edited: false },
      raw: { text: "see both" },
      text: "see both",
      threadId: "test:C01:1700000000.000001",
    });

    expect(messageContentOf(mixed)).toEqual([
      { text: "see both", type: "text" },
      {
        text: "Attachment pasted was not retrieved: the platform did not provide a download for it.",
        type: "text",
      },
      expect.objectContaining({ filename: "a.pdf", type: "file" }),
    ]);
  });
});
