import { describe, expect, it, vi } from "vitest";

import { INACTIVE_REQUEST_NOTICE } from "#channel/inactive-prompt.js";
import { isCompiledChannel } from "#channel/compiled-channel.js";
import { isHttpRouteDefinition } from "#channel/routes.js";
import { SessionNotActiveError } from "#channel/session-not-active-error.js";
import type {
  Adapter,
  AdapterPostableMessage,
  ChatInstance,
  EphemeralMessage,
  FetchResult,
  FormattedContent,
  RawMessage,
  StateAdapter,
  ThreadInfo,
  WebhookOptions,
} from "#compiled/chat/index.js";
import { Message, parseMarkdown } from "#compiled/chat/index.js";
import { mockChannelContext } from "#internal/testing/mocks/mock-channel-operations.js";
import { mockAgentRouteArgs } from "#internal/testing/mocks/mock-route-args.js";
import { chatSdkChannel, type ChatSdkChannelState } from "#public/channels/chat-sdk/index.js";

const THREAD_ID = "test:C01:1700000000.000001";
const CHANNEL_ID = "test:C01";
const PRESS = { actionId: "eve_input:request-1:approve", kind: "action", value: "approve" };

/** Posts a press to the bridge's webhook and drains every task it hands to `waitUntil`. */
async function firePress(channel: unknown, sendError?: Error): Promise<Response> {
  if (!isCompiledChannel(channel)) throw new Error("Expected a compiled channel.");
  const post = channel.routes.find(
    (route) => route.method === "POST" && route.path === "/eve/v1/test",
  );
  if (!post || !isHttpRouteDefinition(post)) throw new Error("Expected POST /eve/v1/test.");
  const send = vi.fn().mockResolvedValue({ id: "session-1" });
  if (sendError) send.mockRejectedValue(sendError);
  const waitUntil = vi.fn();
  const response = await post.handler(
    new Request("https://example.com/eve/v1/test", {
      body: JSON.stringify(PRESS),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
    {
      ...mockAgentRouteArgs(),
      ...mockChannelContext<ChatSdkChannelState>(send),
      attachSession: vi.fn() as never,
      params: {},
      requestIp: null,
      to: vi.fn() as never,
      waitUntil,
    },
  );
  let drained = 0;
  while (drained < waitUntil.mock.calls.length) {
    const pending = waitUntil.mock.calls.slice(drained).map(([task]) => task as Promise<unknown>);
    drained = waitUntil.mock.calls.length;
    await Promise.allSettled(pending);
  }
  return response;
}

describe("chatSdkChannel pressing a button no session can take", () => {
  async function pressWith(adapter: TestAdapter & Adapter, error: Error) {
    const ephemerals: Array<{ message: AdapterPostableMessage; userId: string }> = [];
    adapter.postEphemeral = async (threadId, userId, posted) => {
      ephemerals.push({ message: posted, userId });
      return { id: "e1", raw: {}, threadId, usedFallback: false };
    };
    const bridge = chatSdkChannel({
      adapters: { test: adapter },
      concurrency: "concurrent",
      logger: "warn",
      state: memoryState(),
      userName: "bot",
    });
    const response = await firePress(bridge.channel, error);
    expect(response.status).toBe(200);
    return ephemerals;
  }

  it("retires the pressed card and tells only the presser", async () => {
    const adapter = testAdapter();

    const ephemerals = await pressWith(adapter, new SessionNotActiveError());

    expect(adapter.edited).toMatchObject([
      {
        message: {
          card: { type: "card", children: [{ type: "text", content: "No longer active" }] },
          fallbackText: "No longer active",
        },
        messageId: "message-1",
        threadId: THREAD_ID,
      },
    ]);
    expect(ephemerals).toEqual([
      { message: { markdown: INACTIVE_REQUEST_NOTICE }, userId: author().userId },
    ]);
  });

  it("still tells the presser when the adapter can't edit", async () => {
    const adapter = testAdapter();
    adapter.editError = new NotImplementedError("editMessage");

    const ephemerals = await pressWith(adapter, new SessionNotActiveError());

    expect(adapter.edited).toEqual([]);
    expect(ephemerals).toHaveLength(1);
  });

  it.each([
    ["authorization", { resolveInputAuth: () => Promise.reject(new Error("auth down")) }],
    ["delivery", {}, new Error("network down")],
  ] as const)(
    "lets Chat SDK see a failed %s and leaves the card live",
    async (_, config, sendError?: Error) => {
      const adapter = testAdapter();
      adapter.postEphemeral = vi.fn();
      const bridge = chatSdkChannel({
        adapters: { test: adapter },
        concurrency: "concurrent",
        logger: "warn",
        state: memoryState(),
        userName: "bot",
        ...config,
      });
      const later = vi.fn();
      bridge.bot.onAction(later);

      await expect(firePress(bridge.channel, sendError)).rejects.toThrow(
        sendError?.message ?? "auth down",
      );

      expect(later).not.toHaveBeenCalled();
      expect(adapter.edited).toEqual([]);
      expect(adapter.postEphemeral).not.toHaveBeenCalled();
    },
  );
});

function testAdapter(): TestAdapter & Adapter {
  return new TestAdapter() as TestAdapter & Adapter;
}

class NotImplementedError extends Error {
  readonly code = "NOT_IMPLEMENTED";

  constructor(feature: string) {
    super(`${feature} is not implemented`);
    this.name = "NotImplementedError";
  }
}

/** An adapter whose webhook turns a `{ kind: "action" }` body into a press on `message-1`. */
class TestAdapter {
  readonly name = "test";
  readonly userName = "bot";
  chat: ChatInstance | null = null;
  edited: Array<{ message: AdapterPostableMessage; messageId: string; threadId: string }> = [];
  editError: Error | null = null;
  postEphemeral?: (
    threadId: string,
    userId: string,
    message: AdapterPostableMessage,
  ) => Promise<EphemeralMessage | null>;

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
  }

  async handleWebhook(request: Request, options?: WebhookOptions): Promise<Response> {
    const body = (await request.json()) as { actionId?: string; value?: string };
    await this.chat?.processAction(
      {
        actionId: body.actionId ?? "",
        adapter: this as Adapter,
        messageId: "message-1",
        raw: body,
        threadId: THREAD_ID,
        user: author(),
        value: body.value,
      },
      options,
    );
    return new Response("ok");
  }

  channelIdFromThreadId(_threadId: string): string {
    return CHANNEL_ID;
  }

  decodeThreadId(threadId: string): { threadId: string } {
    return { threadId };
  }

  encodeThreadId(input: { threadId: string }): string {
    return input.threadId;
  }

  getChannelVisibility(): "workspace" {
    return "workspace";
  }

  isDM(): boolean {
    return false;
  }

  parseMessage(raw: { text?: string }): Message {
    const text = raw.text ?? "";
    return new Message({
      attachments: [],
      author: author(),
      formatted: parseMarkdown(text),
      id: "message-1",
      isMention: true,
      metadata: { dateSent: new Date("2026-01-01T00:00:00.000Z"), edited: false },
      raw: { text },
      text,
      threadId: THREAD_ID,
    });
  }

  renderFormatted(_content: FormattedContent): string {
    return "";
  }

  async fetchMessages(): Promise<FetchResult> {
    return { messages: [] };
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    return {
      channelId: CHANNEL_ID,
      channelVisibility: "workspace",
      id: threadId,
      isDM: false,
      metadata: {},
    };
  }

  async postMessage(threadId: string, posted: AdapterPostableMessage): Promise<RawMessage> {
    return { id: "posted", raw: posted, threadId };
  }

  async editMessage(
    threadId: string,
    messageId: string,
    posted: AdapterPostableMessage,
  ): Promise<RawMessage> {
    if (this.editError) throw this.editError;
    this.edited.push({ message: posted, messageId, threadId });
    return { id: "edited", raw: posted, threadId };
  }

  async addReaction(): Promise<void> {}
  async deleteMessage(): Promise<void> {}
  async removeReaction(): Promise<void> {}
  async startTyping(): Promise<void> {}
}

function author() {
  return {
    fullName: "Test User",
    isBot: false,
    isMe: false,
    userId: "user-1",
    userName: "alice",
  } as const;
}

function memoryState(): StateAdapter {
  const values = new Map<string, unknown>();
  const lists = new Map<string, unknown[]>();
  const subscriptions = new Set<string>();
  return {
    async acquireLock(threadId: string) {
      return { expiresAt: Date.now() + 1_000, threadId, token: "lock" };
    },
    async appendToList(key: string, value: unknown) {
      lists.set(key, [...(lists.get(key) ?? []), value]);
    },
    async connect() {},
    async delete(key: string) {
      values.delete(key);
    },
    async dequeue() {
      return null;
    },
    async disconnect() {},
    async enqueue() {
      return 1;
    },
    async extendLock() {
      return true;
    },
    async forceReleaseLock() {},
    async get(key: string) {
      return (values.get(key) ?? null) as any;
    },
    async getList(key: string) {
      return (lists.get(key) ?? []) as any[];
    },
    async isSubscribed(threadId: string) {
      return subscriptions.has(threadId);
    },
    async queueDepth() {
      return 0;
    },
    async releaseLock() {},
    async set(key: string, value: unknown) {
      values.set(key, value);
    },
    async setIfNotExists(key: string, value: unknown) {
      if (values.has(key)) return false;
      values.set(key, value);
      return true;
    },
    async subscribe(threadId: string) {
      subscriptions.add(threadId);
    },
    async unsubscribe(threadId: string) {
      subscriptions.delete(threadId);
    },
  };
}
