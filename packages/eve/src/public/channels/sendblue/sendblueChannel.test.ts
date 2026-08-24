import { beforeEach, describe, expect, it, vi } from "vitest";

const { createAdapter, markRead, mention, send, vercelOidc } = vi.hoisted(() => ({
  createAdapter: vi.fn(),
  markRead: vi.fn(),
  mention: vi.fn(),
  send: vi.fn(),
  vercelOidc: vi.fn(() => vi.fn()),
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
  createSendblueAdapter: createAdapter.mockReturnValue({ markRead }),
}));
vi.mock("#public/channels/auth.js", () => ({ vercelOidc }));

import { Message } from "#compiled/chat/index.js";
import { sendblueChannel } from "#public/channels/sendblue/sendblueChannel.js";

describe("sendblueChannel", () => {
  beforeEach(() => vi.clearAllMocks());

  it("dispatches Sendblue mentions without subscribing the thread", async () => {
    sendblueChannel({
      credentials: { accessToken: "token", defaultFromNumber: "+15551234567" },
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

  it("passes direct credentials and webhook configuration to the adapter", async () => {
    sendblueChannel({
      credentials: {
        apiKey: "api-key",
        apiSecret: "api-secret",
        defaultFromNumber: "+15551234567",
        webhookSecret: "webhook-secret",
      },
    });

    const adapterConfig = createAdapter.mock.calls[0]?.[0];
    expect(adapterConfig.defaultFromNumber).toBe("+15551234567");
    expect(adapterConfig.apiKey).toBe("api-key");
    expect(adapterConfig.apiSecret).toBe("api-secret");
    expect(adapterConfig.webhookSecret).toBe("webhook-secret");
  });

  it("uses managed credentials for its line and webhook verification", async () => {
    const webhookVerifier = vi.fn();
    const accessToken = vi.fn(async () => "token");
    const defaultFromNumber = vi.fn(async () => "+15551234567");
    const allowedFromNumbers = vi.fn(async () => ["+15551234567"]);

    sendblueChannel({
      credentials: { accessToken, defaultFromNumber, allowedFromNumbers, webhookVerifier },
    });

    const adapterConfig = createAdapter.mock.calls[0]?.[0];
    expect(adapterConfig.accessToken).toBe(accessToken);
    expect(adapterConfig.defaultFromNumber).toBe(defaultFromNumber);
    expect(adapterConfig.allowedFromNumbers).toBe(allowedFromNumbers);
    expect(adapterConfig.webhookVerifier).toBe(webhookVerifier);
  });
});
