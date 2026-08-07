import { beforeEach, describe, expect, it, vi } from "vitest";

const { createSendblueAdapter, directMessage, newMessage, send } = vi.hoisted(() => ({
  createSendblueAdapter: vi.fn(),
  directMessage: vi.fn(),
  newMessage: vi.fn(),
  send: vi.fn(),
}));

vi.mock("#public/channels/chat-sdk/index.js", () => ({
  chatSdkChannel: () => ({
    bot: {
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
vi.mock("#compiled/chat-adapter-sendblue/index.js", () => ({ createSendblueAdapter }));

import { Message } from "#compiled/chat/index.js";
import { sendblueChannel } from "#public/channels/sendblue/sendblueChannel.js";

describe("sendblueChannel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("cancels the active eve turn before steering a direct message into its thread", async () => {
    sendblueChannel();
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
      { auth: null, thread, turnPolicy: "experimental-steer" },
    );
  });

  it("passes configured messaging services to the adapter", () => {
    sendblueChannel({ allowedServices: ["iMessage", "SMS", "RCS"] });

    expect(createSendblueAdapter).toHaveBeenCalledWith({
      allowedServices: ["iMessage", "SMS", "RCS"],
    });
  });

  it("drops blank inbound messages without sending", async () => {
    sendblueChannel();
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
    sendblueChannel();
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
      { auth: null, thread, turnPolicy: "experimental-steer" },
    );
  });
});
