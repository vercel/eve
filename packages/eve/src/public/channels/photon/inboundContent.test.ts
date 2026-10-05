import { describe, expect, it } from "vitest";

import { Message } from "#compiled/chat/index.js";
import { photonInboundContent } from "#public/channels/photon/inboundContent.js";

function message(text: string, attachments: Message["attachments"] = []): Message {
  return new Message({
    attachments,
    formatted: { type: "root", children: [] },
    metadata: { dateSent: new Date(0), edited: false },
    author: { fullName: "User", isBot: false, isMe: false, userId: "user", userName: "user" },
    id: "message-id",
    raw: {},
    text,
    threadId: "thread-id",
  });
}

describe("photonInboundContent", async () => {
  it("returns plain text", async () => {
    expect(await photonInboundContent(message("hello"))).toBe("hello");
  });

  it("drops blank messages", async () => {
    expect(await photonInboundContent(message("  \n"))).toBeUndefined();
  });

  it("drops attachment-only messages when Photon provides no attachment URL", async () => {
    expect(
      await photonInboundContent(
        message("", [
          {
            mimeType: "image/jpeg",
            name: "photo.jpg",
            size: 10,
            type: "image",
          },
        ]),
      ),
    ).toBeUndefined();
  });
});
