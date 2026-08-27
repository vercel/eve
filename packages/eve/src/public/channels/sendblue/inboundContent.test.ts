import { describe, expect, it } from "vitest";

import { Message } from "#compiled/chat/index.js";
import { sendblueInboundContent } from "#public/channels/sendblue/inboundContent.js";

function message(text: string): Message {
  return new Message({
    author: { isBot: false, isMe: false, userId: "user", userName: "user" },
    id: "message-id",
    raw: {},
    text,
    threadId: "thread-id",
  });
}

describe("sendblueInboundContent", () => {
  it("returns plain text", () => {
    expect(sendblueInboundContent(message("hello"))).toBe("hello");
  });

  it("drops blank messages", () => {
    expect(sendblueInboundContent(message(" \n"))).toBeUndefined();
  });
});
