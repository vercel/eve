import { beforeEach, describe, expect, it, vi } from "vitest";

const { markRead, mention, send } = vi.hoisted(() => ({
  markRead: vi.fn(),
  mention: vi.fn(),
  send: vi.fn(),
}));

vi.mock("#public/channels/chat-sdk/index.js", () => ({
  chatSdkChannel: () => ({
    bot: { getAdapter: () => ({ markRead }), onNewMention: mention },
    channel: { routes: [] },
    send,
  }),
  messageToUserContent: (message: Message) => message.text,
}));
vi.mock("#compiled/@chat-adapter/state-memory/index.js", () => ({ createMemoryState: vi.fn() }));
vi.mock("#compiled/chat-adapter-sendblue/index.js", () => ({
  createSendblueAdapter: vi.fn(() => ({ markRead })),
}));
vi.mock("#public/channels/auth.js", () => ({ vercelOidc: vi.fn() }));

import { Message } from "#compiled/chat/index.js";
import { sendblueChannel } from "#public/channels/sendblue/sendblueChannel.js";

describe("sendblueChannel", () => {
  beforeEach(() => vi.clearAllMocks());

  it("dispatches Sendblue mentions without subscribing the thread", async () => {
    sendblueChannel({
      credentials: async () => ({ accessToken: "token" }),
      fromNumber: "+15551234567",
    });
    const handler = mention.mock.calls[0]?.[0];
    if (handler === undefined) throw new Error("Expected an inbound mention handler.");
    const thread = { id: "thread-id" };
    const message = new Message({
      author: { isBot: false, isMe: false, userId: "user", userName: "user" },
      id: "message-id",
      raw: {},
      text: "Hello Sendblue",
      threadId: thread.id,
    });

    await handler(thread, message);

    expect(markRead).toHaveBeenCalledWith(thread.id);
    expect(send).toHaveBeenCalledWith(
      { context: [], message: "Hello Sendblue" },
      { auth: null, thread, turnPolicy: "experimental-steer" },
    );
  });
});
