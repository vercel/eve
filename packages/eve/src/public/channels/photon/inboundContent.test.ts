import { describe, expect, it } from "vitest";

import { Message } from "#compiled/chat/index.js";
import { photonInboundContent } from "#public/channels/photon/inboundContent.js";

function message(text: string, attachments: Message["attachments"] = []): Message {
  return new Message({
    attachments,
    author: { fullName: "user", isBot: false, isMe: false, userId: "user", userName: "user" },
    formatted: { type: "root", children: [] },
    id: "message-id",
    metadata: { dateSent: new Date(), edited: false },
    raw: {},
    text,
    threadId: "thread-id",
  });
}

describe("photonInboundContent", () => {
  it("returns plain text", () => {
    expect(photonInboundContent(message("hello"))).toBe("hello");
  });

  it("drops blank messages", () => {
    expect(photonInboundContent(message("  \n"))).toBeUndefined();
  });

  it("drops attachment-only messages when Photon provides no attachment URL", () => {
    expect(
      photonInboundContent(
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
