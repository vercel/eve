import { describe, expect, it, vi } from "vitest";

import { captureResendReplyContext, restoreResendReplyContext } from "./index.js";

describe("restoreResendReplyContext", () => {
  it("seeds subject and reply message ids from a durable serialized message", () => {
    const trackMessage = vi.fn();
    const trackSubject = vi.fn();
    const adapter = {
      name: "resend",
      threadResolver: { trackMessage, trackSubject },
    };
    const thread = {
      _type: "chat:Thread",
      adapterName: "resend",
      channelId: "resend:ben@example.com",
      id: "resend:ben@example.com:root",
      isDM: false,
      currentMessage: {
        _type: "chat:Message",
        id: "email-1",
        threadId: "resend:ben@example.com:root",
        text: "hello",
        formatted: { type: "root", children: [] },
        raw: {
          subject: "Eve test",
          messageId: "<current@example.com>",
          headers: { References: "<root@example.com> <previous@example.com>" },
        },
        author: {
          userId: "ben@example.com",
          userName: "ben@example.com",
          fullName: "Ben",
          isBot: false,
          isMe: false,
          isSystem: false,
        },
        metadata: { dateSent: new Date().toISOString(), edited: false },
        attachments: [],
        isMention: true,
        links: [],
      },
    };
    const context = captureResendReplyContext({ adapter: adapter as never, thread });
    restoreResendReplyContext({ adapter: adapter as never, context, thread });

    expect(context).toMatchObject({ messageId: "<current@example.com>", subject: "Eve test" });
    expect(trackSubject).toHaveBeenCalledWith("resend:ben@example.com:root", "Eve test");
    expect(trackMessage.mock.calls.map((call) => call[1])).toEqual([
      "<root@example.com>",
      "<previous@example.com>",
      "<current@example.com>",
    ]);
  });

  it("ignores adapters that do not expose the experimental resolver", () => {
    expect(() =>
      restoreResendReplyContext({
        adapter: { name: "resend" } as never,
        context: undefined,
        thread: {
          _type: "chat:Thread",
          adapterName: "resend",
          channelId: "resend:user@example.com",
          id: "resend:user@example.com:root",
          isDM: false,
        },
      }),
    ).not.toThrow();
  });
});
