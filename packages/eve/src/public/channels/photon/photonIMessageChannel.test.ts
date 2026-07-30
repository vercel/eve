import { describe, expect, it, vi } from "vitest";

const { newMention, send, subscribe } = vi.hoisted(() => ({
  newMention: vi.fn(),
  send: vi.fn(),
  subscribe: vi.fn(),
}));

vi.mock("#public/channels/chat-sdk/index.js", () => ({
  chatSdkChannel: () => ({
    bot: {
      getAdapter: () => ({ markRead: vi.fn() }),
      onNewMention: newMention,
      onSubscribedMessage: vi.fn(),
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
  it("subscribes to a blank first mention before dropping it", async () => {
    photonIMessageChannel({
      credentials: async () => ({ projectId: "project-id", projectSecret: "project-secret" }),
    });
    const handler = newMention.mock.calls[0]?.[0];
    if (handler === undefined) throw new Error("Expected an inbound mention handler.");
    const thread = { id: "thread-id", subscribe };
    const message = new Message({
      author: { isBot: false, isMe: false, userId: "user", userName: "user" },
      id: "message-id",
      raw: {},
      text: "  \n",
      threadId: thread.id,
    });

    await handler(thread, message);

    expect(subscribe).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });
});
