import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createiMessageAdapter,
  directMessage,
  fetchMessage,
  newMessage,
  reaction,
  send,
  vercelOidc,
} = vi.hoisted(() => ({
  createiMessageAdapter: vi.fn(
    (_config: { webhookVerifier?: (request: Request) => unknown }) => ({}),
  ),
  directMessage: vi.fn(),
  fetchMessage: vi.fn(),
  newMessage: vi.fn(),
  reaction: vi.fn(),
  send: vi.fn(),
  vercelOidc: vi.fn(),
}));

vi.mock("#public/channels/chat-sdk/index.js", () => ({
  chatSdkChannel: () => ({
    bot: {
      getAdapter: () => ({ fetchMessage, markRead: vi.fn() }),
      initialize: vi.fn(),
      onDirectMessage: directMessage,
      onNewMessage: newMessage,
      onReaction: reaction,
    },
    channel: { __kind: "eve:channel", adapter: { kind: "channel:photon" }, routes: [] },
    send,
  }),
  messageToUserContent: (message: Message) => message.text,
}));
vi.mock("#compiled/@chat-adapter/state-memory/index.js", () => ({
  createMemoryState: vi.fn(),
}));
vi.mock("#compiled/@photon-ai/chat-adapter-imessage/index.js", () => ({
  createiMessageAdapter,
}));
vi.mock("#public/channels/auth.js", () => ({ vercelOidc }));

import {
  defaultPhotonAuth,
  photonIMessageChannel,
} from "#public/channels/photon/photonIMessageChannel.js";
import { Message } from "#compiled/chat/index.js";
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
