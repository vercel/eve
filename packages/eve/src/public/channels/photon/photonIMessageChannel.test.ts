import { beforeEach, describe, expect, it, vi } from "vitest";

const { directMessage, newMessage, send } = vi.hoisted(() => ({
  directMessage: vi.fn(),
  newMessage: vi.fn(),
  send: vi.fn(),
}));

vi.mock("#public/channels/chat-sdk/index.js", () => ({
  chatSdkChannel: () => ({
    bot: {
      getAdapter: () => ({ markRead: vi.fn() }),
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
vi.mock("#compiled/@photon-ai/chat-adapter-imessage/index.js", () => ({
  createiMessageAdapter: vi.fn(),
}));
vi.mock("#public/channels/auth.js", () => ({ vercelOidc: vi.fn() }));

import { photonIMessageChannel } from "#public/channels/photon/photonIMessageChannel.js";
import { Message } from "#compiled/chat/index.js";

describe("photonIMessageChannel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("inherits the shared steering default for a direct message", async () => {
    photonIMessageChannel({
      credentials: async () => ({ projectId: "project-id", projectSecret: "project-secret" }),
    });
    const handler = directMessage.mock.calls[0]?.[0];
    if (handler === undefined) throw new Error("Expected an inbound direct-message handler.");
    const thread = { id: "thread-id" };
    const message = new Message({
      author: { isBot: false, isMe: false, userId: "user", userName: "user" },
      id: "message-id",
      raw: {},
      text: "Steer this response",
      threadId: thread.id,
    });

    await handler(thread, message);

    expect(send).toHaveBeenCalledWith(
      { context: [], message: "Steer this response" },
      { auth: null, thread },
    );
  });

  it("drops blank inbound messages without cancelling or sending", async () => {
    photonIMessageChannel({
      credentials: async () => ({ projectId: "project-id", projectSecret: "project-secret" }),
    });
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

    expect(send).not.toHaveBeenCalled();
  });

  it("routes group messages without a Chat SDK subscription", async () => {
    photonIMessageChannel({
      credentials: async () => ({ projectId: "project-id", projectSecret: "project-secret" }),
    });
    const [pattern, handler] = newMessage.mock.calls[0] ?? [];
    if (!(pattern instanceof RegExp) || handler === undefined) {
      throw new Error("Expected an inbound group-message handler.");
    }
    const thread = { id: "group-thread-id" };
    const message = new Message({
      author: { isBot: false, isMe: false, userId: "user", userName: "user" },
      id: "message-id",
      raw: {},
      text: "Hello group",
      threadId: thread.id,
    });

    expect(pattern.test(message.text)).toBe(true);
    await handler(thread, message);

    expect(send).toHaveBeenCalledWith(
      { context: [], message: "Hello group" },
      { auth: null, thread },
    );
  });
});
