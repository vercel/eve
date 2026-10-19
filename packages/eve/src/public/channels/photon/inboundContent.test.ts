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

describe("photonInboundContent", () => {
  it("returns plain text", () => {
    expect(photonInboundContent(message("hello"))).toBe("hello");
  });

  it("drops blank messages", () => {
    expect(photonInboundContent(message("  \n"))).toBeUndefined();
  });

  it("notes an attachment-only message Photon sends without a download", () => {
    expect(
      photonInboundContent(
        message("", [{ mimeType: "audio/x-caf", name: "voice", size: 10, type: "audio" }]),
      ),
    ).toEqual([
      {
        text: "Attachment voice was not retrieved: the platform did not provide a download for it.",
        type: "text",
      },
    ]);
  });
});
