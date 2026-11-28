import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  chatSdkChannel,
  createiMessageAdapter,
  createMemoryState,
  directMessage,
  fetchMessage,
  newMessage,
  reaction,
  send,
  vercelOidc,
} = vi.hoisted(() => ({
  chatSdkChannel: vi.fn(),
  createiMessageAdapter: vi.fn(
    (_config: { webhookVerifier?: (request: Request) => unknown }) => ({}),
  ),
  createMemoryState: vi.fn(() => ({ kind: "memory-state" })),
  directMessage: vi.fn(),
  fetchMessage: vi.fn(),
  newMessage: vi.fn(),
  reaction: vi.fn(),
  send: vi.fn(),
  vercelOidc: vi.fn(),
}));

vi.mock("#public/channels/chat-sdk/index.js", () => ({
  chatSdkChannel: chatSdkChannel.mockImplementation(() => ({
    bot: {
      getAdapter: () => ({ fetchMessage, markRead: vi.fn() }),
      initialize: vi.fn(),
      onDirectMessage: directMessage,
      onNewMessage: newMessage,
      onReaction: reaction,
    },
    channel: { __kind: "eve:channel", adapter: { kind: "channel:photon" }, routes: [] },
    send,
  })),
  messageContentOf: (message: Message) => message.text,
}));
vi.mock("#compiled/@chat-adapter/state-memory/index.js", () => ({ createMemoryState }));
vi.mock("#compiled/@photon-ai/chat-adapter-imessage/index.js", () => ({
  createiMessageAdapter,
}));
vi.mock("#public/channels/auth.js", () => ({ vercelOidc }));

import {
  defaultPhotonAuth,
  photonIMessageChannel,
} from "#public/channels/photon/photonIMessageChannel.js";
import { getEmoji, Message } from "#compiled/chat/index.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

describe("photonIMessageChannel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("verifies webhooks by default only with Vercel OIDC from the current environment", async () => {
    const runtime = { principalType: "runtime", subject: "production" };
    const verify = vi.fn();
    vercelOidc.mockReturnValue(verify);
    photonIMessageChannel({
      credentials: async () => ({ projectId: "project-id", projectSecret: "project-secret" }),
    });
    const webhookVerifier = createiMessageAdapter.mock.calls[0]?.[0].webhookVerifier;
    if (webhookVerifier === undefined) throw new Error("Expected a default webhook verifier.");
    const request = new Request("https://agent.example/webhook", { method: "POST" });

    verify.mockResolvedValueOnce({ principalType: "service", subject: "preview" });
    await expect(webhookVerifier(request)).resolves.toBeNull();
    verify.mockResolvedValueOnce(runtime);
    await expect(webhookVerifier(request)).resolves.toBe(runtime);
  });

  it("defaults to in-memory state and eve's iMessage adapter", () => {
    photonIMessageChannel({
      credentials: async () => ({ projectId: "project-id", projectSecret: "project-secret" }),
    });

    const config = chatSdkChannel.mock.calls[0]?.[0];
    expect(config.state).toEqual({ kind: "memory-state" });
    expect(config.adapters.imessage).toBe(createiMessageAdapter.mock.results[0]?.value);
    expect(config.adapters.imessage.rehydrateAttachment).toEqual(expect.any(Function));
  });

  it("uses a supplied state adapter instead of in-memory state", () => {
    const state = { kind: "durable-state" } as never;

    photonIMessageChannel({
      credentials: async () => ({ projectId: "project-id", projectSecret: "project-secret" }),
      state,
    });

    expect(createMemoryState).not.toHaveBeenCalled();
    expect(chatSdkChannel.mock.calls[0]?.[0].state).toBe(state);
  });

  it("uses the adapter returned by the adapter option, with attachment rehydration", () => {
    const wrapped = { wrapped: true };
    const adapter = vi.fn(() => wrapped as never);

    photonIMessageChannel({
      adapter,
      credentials: async () => ({ projectId: "project-id", projectSecret: "project-secret" }),
    });

    expect(adapter).toHaveBeenCalledWith(createiMessageAdapter.mock.results[0]?.value);
    expect(chatSdkChannel.mock.calls[0]?.[0].adapters.imessage).toBe(wrapped);
    expect(wrapped).toHaveProperty("rehydrateAttachment", expect.any(Function));
  });

  it("sends emoji tapbacks through the fetched spectrum message", async () => {
    const react = vi.fn();
    fetchMessage.mockResolvedValue({ raw: { react } });
    const tool = photonIMessageChannel({
      credentials: async () => ({ projectId: "project-id", projectSecret: "project-secret" }),
    }).tapbackTool();
    const ctx = new ContextContainer();
    ctx.set(ChannelKey, {
      kind: "channel:photon",
      state: { latestMessageId: "latest-id", thread: { id: "imessage:chat" } },
    } as never);

    await contextStorage.run(ctx, () => tool.execute({ tapback: "🎉" }, {} as never));

    expect(fetchMessage).toHaveBeenCalledWith("imessage:chat", "latest-id");
    expect(react).toHaveBeenCalledWith("🎉");
  });

  it("ignores tapbacks unless onTapback accepts them", () => {
    const credentials = async () => ({ projectId: "project-id", projectSecret: "project-secret" });
    photonIMessageChannel({ credentials });
    expect(reaction).not.toHaveBeenCalled();

    photonIMessageChannel({
      credentials,
      onTapback: (_ctx, tapback) => ({ auth: defaultPhotonAuth(tapback) }),
    });
    expect(reaction).toHaveBeenCalledTimes(1);
  });

  it("keys tapbacks by the provider's event id so a retried webhook runs one turn", async () => {
    photonIMessageChannel({
      credentials: async () => ({ projectId: "project-id", projectSecret: "project-secret" }),
      onTapback: () => ({ auth: null }),
    });
    const handler = reaction.mock.calls[0]?.[0];
    if (handler === undefined) throw new Error("Expected a tapback handler.");
    const user = { fullName: "User", isBot: false, isMe: false, userId: "user", userName: "user" };

    await handler({
      adapter: {},
      added: true,
      emoji: getEmoji("heart"),
      messageId: "message-id",
      raw: { id: "reaction-message-id" },
      rawEmoji: "love",
      thread: { toJSON: () => ({ id: "thread-id" }) },
      threadId: "thread-id",
      user,
    });

    expect(send).toHaveBeenCalledWith(
      "Tapback: Loved a message",
      expect.objectContaining({ idempotencyKey: "reaction-message-id" }),
    );
  });

  it("inherits the shared steering default for a direct message", async () => {
    photonIMessageChannel({
      credentials: async () => ({ projectId: "project-id", projectSecret: "project-secret" }),
      onMessage: () => ({ auth: null, title: "Photon run" }),
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
      text: "Steer this response",
      threadId: thread.id,
    });

    await handler(thread, message);

    expect(send).toHaveBeenCalledWith("Steer this response", {
      idempotencyKey: "message-id",
      auth: null,
      context: [],
      thread,
      title: "Photon run",
    });
  });

  it("derives user auth for default direct-message dispatch", async () => {
    photonIMessageChannel({
      credentials: async () => ({ projectId: "project-id", projectSecret: "project-secret" }),
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
      text: "Hello Photon",
      threadId: thread.id,
    });

    await handler(thread, message);

    expect(send).toHaveBeenCalledWith("Hello Photon", {
      idempotencyKey: "message-id",
      auth: {
        attributes: { user_name: "user" },
        authenticator: "photon-imessage",
        issuer: "photon",
        principalId: "photon:user",
        principalType: "user",
        subject: "user",
      },
      context: [],
      thread,
      title: undefined,
    });
  });

  it("drops blank inbound messages without cancelling or sending", async () => {
    photonIMessageChannel({
      credentials: async () => ({ projectId: "project-id", projectSecret: "project-secret" }),
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
      attachments: [],
      formatted: { type: "root", children: [] },
      metadata: { dateSent: new Date(0), edited: false },
      author: { fullName: "User", isBot: false, isMe: false, userId: "user", userName: "user" },
      id: "message-id",
      raw: {},
      text: "Hello group",
      threadId: thread.id,
    });

    expect(pattern.test(message.text)).toBe(true);
    await handler(thread, message);

    expect(send).toHaveBeenCalledWith("Hello group", {
      idempotencyKey: "message-id",
      auth: {
        attributes: { user_name: "user" },
        authenticator: "photon-imessage",
        issuer: "photon",
        principalId: "photon:user",
        principalType: "user",
        subject: "user",
      },
      context: [],
      thread,
      title: undefined,
    });
  });
});
