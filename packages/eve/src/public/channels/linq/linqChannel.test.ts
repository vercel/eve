import { beforeEach, describe, expect, it, vi } from "vitest";

const { createLinqAdapter, directMessage, markRead, newMessage, send } = vi.hoisted(() => ({
  createLinqAdapter: vi.fn(() => ({ name: "linq" })),
  directMessage: vi.fn(),
  markRead: vi.fn(),
  newMessage: vi.fn(),
  send: vi.fn(),
}));

vi.mock("#public/channels/chat-sdk/index.js", () => ({
  chatSdkChannel: () => ({
    bot: {
      getAdapter: () => ({ markRead }),
      onDirectMessage: directMessage,
      onNewMessage: newMessage,
    },
    channel: { routes: [] },
    send,
  }),
  messageToUserContent: (message: Message) => message.text,
}));
vi.mock("#compiled/@chat-adapter/state-memory/index.js", () => ({
  createMemoryState: vi.fn(),
}));
vi.mock("#compiled/@linqapp/chat-sdk-adapter/index.js", () => ({
  createLinqAdapter,
}));
vi.mock("#public/channels/auth.js", () => ({ vercelOidc: vi.fn() }));

import { Message } from "#compiled/chat/index.js";
import { linqChannel } from "#public/channels/linq/linqChannel.js";

describe("linqChannel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches direct messages to eve", async () => {
    linqChannel({ apiKey: "linq-api-key", signingSecret: "linq-signing-secret" });
    const handler = directMessage.mock.calls[0]?.[0];
    if (handler === undefined) throw new Error("Expected an inbound direct-message handler.");
    const thread = { id: "thread-id" };
    const message = new Message({
      author: { isBot: false, isMe: false, userId: "user", userName: "user" },
      id: "message-id",
      raw: {},
      text: "Hello Linq",
      threadId: thread.id,
    });

    await handler(thread, message);

    expect(markRead).toHaveBeenCalledWith(thread.id, message.id);
    expect(send).toHaveBeenCalledWith(
      { context: [], message: "Hello Linq" },
      { auth: null, thread, title: undefined },
    );
  });

  it("uses the managed credential verifier", () => {
    const webhookVerifier = vi.fn();
    const credentials = vi.fn(async () => ({ apiKey: "rotating-token" }));

    linqChannel({ credentials: { credentials, webhookVerifier } });

    expect(createLinqAdapter).toHaveBeenCalledWith({ credentials, webhookVerifier });
  });

  it("drops blank inbound messages", async () => {
    linqChannel({ apiKey: "linq-api-key", signingSecret: "linq-signing-secret" });
    const handler = directMessage.mock.calls[0]?.[0];
    if (handler === undefined) throw new Error("Expected an inbound direct-message handler.");
    const thread = { id: "thread-id" };
    const message = new Message({
      author: { isBot: false, isMe: false, userId: "user", userName: "user" },
      id: "message-id",
      raw: {},
      text: "  \n",
      threadId: thread.id,
    });

    await handler(thread, message);

    expect(markRead).toHaveBeenCalledWith(thread.id, message.id);
    expect(send).not.toHaveBeenCalled();
  });
});
