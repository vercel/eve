import { describe, expect, it } from "vitest";

import { Message } from "#compiled/chat/index.js";
import {
  photonInboundContent,
  photonQuotedMessage,
} from "#public/channels/photon/inboundContent.js";

function message(
  text: string,
  attachments: Message["attachments"] = [],
  raw: unknown = {},
): Message {
  return new Message({
    attachments,
    formatted: { type: "root", children: [] },
    metadata: { dateSent: new Date(0), edited: false },
    author: { fullName: "User", isBot: false, isMe: false, userId: "user", userName: "user" },
    id: "message-id",
    raw,
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

describe("photonQuotedMessage", () => {
  it("returns nothing for a message that is not a reply", () => {
    expect(photonQuotedMessage(message("hi", [], { content: { type: "text", text: "hi" } }))).toBe(
      undefined,
    );
  });

  it("reads the target preview from a webhook reply", () => {
    const raw = {
      content: {
        content: { text: "yes", type: "text" },
        target: { contentPreview: "Dinner at 7?", id: "target-id" },
        type: "reply",
      },
    };
    expect(photonQuotedMessage(message("yes", [], raw))).toEqual({
      id: "target-id",
      text: "Dinner at 7?",
    });
  });

  it("reads the target text from a gateway reply", () => {
    const raw = {
      content: {
        content: { text: "yes", type: "text" },
        target: {
          content: { text: "Dinner at 7?", type: "text" },
          direction: "outbound",
          id: "target-id",
        },
        type: "reply",
      },
    };
    expect(photonQuotedMessage(message("yes", [], raw))).toEqual({
      fromAgent: true,
      id: "target-id",
      text: "Dinner at 7?",
    });
  });

  it("reads the text parts of a multi-part gateway target", () => {
    const raw = {
      content: {
        content: { text: "yes", type: "text" },
        target: {
          content: {
            items: [
              { content: { text: "Here is the menu", type: "text" } },
              { content: { name: "menu.png", type: "attachment" } },
            ],
            type: "group",
          },
          id: "target-id",
        },
        type: "reply",
      },
    };
    expect(photonQuotedMessage(message("yes", [], raw))).toEqual({
      id: "target-id",
      text: "Here is the menu",
    });
  });
});
