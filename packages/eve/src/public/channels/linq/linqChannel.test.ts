import { beforeEach, describe, expect, it, vi } from "vitest";

const { createLinqAdapter, directMessage, markRead, newMessage, reaction, send } = vi.hoisted(
  () => ({
    createLinqAdapter: vi.fn((_config: { credentials?: () => unknown | Promise<unknown> }) => ({
      name: "linq",
    })),
    directMessage: vi.fn(),
    markRead: vi.fn(),
    newMessage: vi.fn(),
    reaction: vi.fn(),
    send: vi.fn(),
  }),
);

vi.mock("#public/channels/chat-sdk/index.js", () => ({
  chatSdkChannel: () => ({
    bot: {
      getAdapter: () => ({ markRead }),
      onDirectMessage: directMessage,
      onNewMessage: newMessage,
      onReaction: reaction,
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
import { defaultLinqAuth, linqChannel } from "#public/channels/linq/linqChannel.js";

describe("linqChannel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches direct messages to eve", async () => {
    linqChannel({
      credentials: { apiKey: "linq-api-key", signingSecret: "linq-signing-secret" },
    });
    const handler = directMessage.mock.calls[0]?.[0];
    if (handler === undefined) throw new Error("Expected an inbound direct-message handler.");
    const thread = { id: "thread-id" };
    const message = new Message({
      attachments: [],
      formatted: { type: "root", children: [] },
      metadata: { dateSent: new Date(0), edited: false },
      author: { fullName: "User", isBot: false, isMe: false, userId: "user", userName: "user" },
      id: "message-id",
      raw: {},
      text: "Hello Linq",
      threadId: thread.id,
    });

    await handler(thread, message);

    expect(markRead).toHaveBeenCalledWith(thread.id, message.id);
    expect(send).toHaveBeenCalledWith("Hello Linq", {
      auth: {
        attributes: { user_name: "user" },
        authenticator: "linq-message",
        issuer: "linq",
        principalId: "linq:user",
        principalType: "user",
        subject: "user",
      },
      context: [],
      thread,
      title: undefined,
    });
  });

  it("uses lazy credentials and the managed credential verifier", async () => {
    const apiKey = vi.fn(async () => "rotating-token");
    const signingSecret = vi.fn(async () => "rotating-secret");
    const webhookVerifier = vi.fn();

    linqChannel({ credentials: { apiKey, signingSecret, webhookVerifier } });

    const config = createLinqAdapter.mock.calls[0]?.[0];
    expect(config).toMatchObject({ webhookVerifier });
    expect(config).not.toHaveProperty("signingSecret");
    await expect(config?.credentials?.()).resolves.toEqual({
      apiKey: "rotating-token",
      signingSecret: "rotating-secret",
    });
  });

  it("drops blank inbound messages", async () => {
    linqChannel({
      credentials: { apiKey: "linq-api-key", signingSecret: "linq-signing-secret" },
    });
    const handler = directMessage.mock.calls[0]?.[0];
    if (handler === undefined) throw new Error("Expected an inbound direct-message handler.");
    const thread = { id: "thread-id" };
    const message = new Message({
      attachments: [],
      formatted: { type: "root", children: [] },
      metadata: { dateSent: new Date(0), edited: false },
      author: { fullName: "User", isBot: false, isMe: false, userId: "user", userName: "user" },
      id: "message-id",
      raw: {},
      text: "  \n",
      threadId: thread.id,
    });

    await handler(thread, message);

    expect(markRead).toHaveBeenCalledWith(thread.id, message.id);
    expect(send).not.toHaveBeenCalled();
  });

  it("ignores tapbacks unless onTapback accepts them", () => {
    linqChannel({ credentials: { apiKey: "linq-api-key", signingSecret: "linq-signing-secret" } });
    expect(reaction).not.toHaveBeenCalled();

    linqChannel({
      credentials: { apiKey: "linq-api-key", signingSecret: "linq-signing-secret" },
      onTapback: (_ctx, tapback) => ({ auth: defaultLinqAuth(tapback) }),
    });
    expect(reaction).toHaveBeenCalledTimes(1);
  });

  it("offers a tapback tool that takes standard tapbacks and emoji", () => {
    const channel = linqChannel({
      credentials: { apiKey: "linq-api-key", signingSecret: "linq-signing-secret" },
    });

    expect(channel.tapbackTool().inputSchema).toMatchObject({
      properties: {
        tapback: {
          description: "One of love, like, dislike, laugh, emphasize, question, or a single emoji.",
        },
      },
    });
  });
});
