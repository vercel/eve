import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createLinqAdapter,
  directMessage,
  fetchMessage,
  markRead,
  newMessage,
  reaction,
  send,
  vercelOidc,
} = vi.hoisted(() => ({
  createLinqAdapter: vi.fn(
    (_config: {
      credentials?: () => unknown | Promise<unknown>;
      webhookVerifier?: (request: Request, rawBody: Uint8Array) => unknown;
    }) => ({
      name: "linq",
    }),
  ),
  directMessage: vi.fn(),
  fetchMessage: vi.fn(),
  markRead: vi.fn(),
  newMessage: vi.fn(),
  reaction: vi.fn(),
  send: vi.fn(),
  vercelOidc: vi.fn(),
}));

vi.mock("#public/channels/chat-sdk/index.js", () => ({
  chatSdkChannel: () => ({
    bot: {
      getAdapter: () => ({ fetchMessage, markRead }),
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
vi.mock("#public/channels/auth.js", () => ({ vercelOidc }));

import { Message } from "#compiled/chat/index.js";
import { defaultLinqAuth, linqChannel } from "#public/channels/linq/linqChannel.js";

function forgedWebhook(): Request {
  return new Request("https://agent.example/eve/v1/linq", {
    body: JSON.stringify({ event_type: "message.received", data: { direction: "inbound" } }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

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

  it("tells the model which message a reply quotes", async () => {
    linqChannel({
      credentials: { apiKey: "linq-api-key", signingSecret: "linq-signing-secret" },
    });
    const handler = directMessage.mock.calls[0]?.[0];
    if (handler === undefined) throw new Error("Expected an inbound direct-message handler.");
    const thread = { id: "thread-id" };
    const message = (text: string, raw: unknown, isMe = false) =>
      new Message({
        attachments: [],
        formatted: { type: "root", children: [] },
        metadata: { dateSent: new Date(0), edited: false },
        author: { fullName: "User", isBot: isMe, isMe, userId: "user", userName: "user" },
        id: "message-id",
        raw,
        text,
        threadId: thread.id,
      });
    fetchMessage.mockResolvedValueOnce(message("Dinner at 7?", {}, true));

    await handler(thread, message("yes", { reply_to: { message_id: "target-id" } }));

    expect(fetchMessage).toHaveBeenCalledWith(thread.id, "target-id");
    expect(send).toHaveBeenCalledWith(
      "yes",
      expect.objectContaining({
        context: [
          [
            "<reply_context>",
            'The person\'s message "yes" is a reply to one of your earlier messages (message_id: target-id).',
            "<quoted_message>",
            "Dinner at 7?",
            "</quoted_message>",
            "</reply_context>",
          ].join("\n"),
        ],
      }),
    );
  });

  it("uses lazy credentials and the managed credential verifier", async () => {
    const apiKey = vi.fn(async () => "rotating-token");
    const signingSecret = vi.fn(async () => "rotating-secret");
    const webhookVerifier = vi.fn(async () => true);

    linqChannel({ credentials: { apiKey, signingSecret, webhookVerifier } });

    const config = createLinqAdapter.mock.calls[0]?.[0];
    expect(config).not.toHaveProperty("signingSecret");
    const request = forgedWebhook();
    const rawBody = new Uint8Array();
    await expect(config?.webhookVerifier?.(request, rawBody)).resolves.toBe(true);
    expect(webhookVerifier).toHaveBeenCalledWith(request, rawBody);
    await expect(config?.credentials?.()).resolves.toEqual({
      apiKey: "rotating-token",
      signingSecret: "rotating-secret",
    });
  });

  it.each([
    ["default Vercel OIDC verifier", undefined],
    ["supplied verifier", () => null],
  ])("rejects webhooks when the %s returns a falsy result", async (_name, webhookVerifier) => {
    vercelOidc.mockReturnValue(async () => null);
    const { createLinqAdapter: createRealLinqAdapter } = await vi.importActual<
      typeof import("#compiled/@linqapp/chat-sdk-adapter/index.js")
    >("#compiled/@linqapp/chat-sdk-adapter/index.js");

    linqChannel({ credentials: { apiKey: "linq-api-key", webhookVerifier } });
    const config = createLinqAdapter.mock.calls[0]?.[0];
    if (config === undefined) throw new Error("Expected Linq adapter config.");
    const response = await createRealLinqAdapter(config).handleWebhook(forgedWebhook());

    expect(response.status).toBe(401);
  });

  it("rejects default-verified webhooks signed by another environment of the project", async () => {
    vercelOidc.mockReturnValue(async () => ({ principalType: "service", subject: "preview" }));
    const { createLinqAdapter: createRealLinqAdapter } = await vi.importActual<
      typeof import("#compiled/@linqapp/chat-sdk-adapter/index.js")
    >("#compiled/@linqapp/chat-sdk-adapter/index.js");

    linqChannel({ credentials: { apiKey: "linq-api-key" } });
    const config = createLinqAdapter.mock.calls[0]?.[0];
    if (config === undefined) throw new Error("Expected Linq adapter config.");
    const response = await createRealLinqAdapter(config).handleWebhook(forgedWebhook());

    expect(response.status).toBe(401);
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
