import { beforeEach, describe, expect, it, vi } from "vitest";

import { isCompiledChannel, type CompiledChannel } from "#channel/compiled-channel.js";
import { isHttpRouteDefinition } from "#channel/routes.js";
import { mockChannelContext } from "#internal/testing/mocks/mock-channel-operations.js";
import type { ChatSdkChannelState } from "#public/channels/chat-sdk/index.js";
import { photonIMessageChannel } from "#public/channels/photon/photonIMessageChannel.js";
import type { RouteHandlerArgs } from "#public/definitions/channel.js";
import type {
  Adapter,
  AdapterPostableMessage,
  ChatInstance,
  FetchResult,
  FormattedContent,
  QueueEntry,
  RawMessage,
  StateAdapter,
  ThreadInfo,
  WebhookOptions,
} from "#compiled/chat/index.js";
import { Message, parseMarkdown } from "#compiled/chat/index.js";

const { createiMessageAdapter } = vi.hoisted(() => ({
  createiMessageAdapter: vi.fn(),
}));

vi.mock("#compiled/@photon-ai/chat-adapter-imessage/index.js", () => ({
  createiMessageAdapter,
}));
vi.mock("#public/channels/auth.js", () => ({ vercelOidc: vi.fn() }));

const DEDUPE_TTL_MS = 48 * 60 * 60 * 1_000;
const THREAD_ID = "imessage:any;-;+15551234567";

describe("photonIMessageChannel durable deduplication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createiMessageAdapter.mockImplementation(() => new TestPhotonAdapter());
  });

  it("dispatches a repeated message id once across concurrent requests and recreated channels", async () => {
    const values = new Map<string, unknown>();
    const dedupeTtls: number[] = [];
    const state = () => new SharedStateAdapter(values, dedupeTtls);
    const onMessage = vi.fn(async () => null);
    const first = createChannel(state(), onMessage);
    const second = createChannel(state(), onMessage);

    await Promise.all([
      firePhotonWebhook(first, "stable-message-id"),
      firePhotonWebhook(second, "stable-message-id"),
    ]);

    const recreated = createChannel(state(), onMessage);
    await firePhotonWebhook(recreated, "stable-message-id");

    expect(onMessage).toHaveBeenCalledOnce();
    expect(dedupeTtls).toEqual([DEDUPE_TTL_MS, DEDUPE_TTL_MS, DEDUPE_TTL_MS]);
  });
});

function createChannel(state: StateAdapter, onMessage: () => Promise<null>) {
  return photonIMessageChannel({
    credentials: async () => ({ projectId: "project-id", projectSecret: "project-secret" }),
    dedupeTtlMs: DEDUPE_TTL_MS,
    onMessage,
    state,
  });
}

async function firePhotonWebhook(channel: unknown, messageId: string): Promise<void> {
  const compiled = compiledChannel(channel);
  const route = compiled.routes.find(
    (candidate) => candidate.method === "POST" && candidate.path === "/eve/v1/photon",
  );
  if (!route || !isHttpRouteDefinition(route)) {
    throw new Error("Expected the Photon POST route.");
  }

  const waitUntilTasks: Promise<unknown>[] = [];
  const channelContext = mockChannelContext<ChatSdkChannelState>(vi.fn());
  const response = await route.handler(
    new Request("https://example.com/eve/v1/photon", {
      body: JSON.stringify({ messageId }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
    {
      attachSession: vi.fn(),
      from: channelContext.from,
      params: {},
      requestIp: null,
      resolveSession: channelContext.resolveSession,
      to: vi.fn(),
      waitUntil(task) {
        waitUntilTasks.push(task);
      },
    } satisfies RouteHandlerArgs<ChatSdkChannelState>,
  );

  expect(response.status).toBe(200);
  await Promise.all(waitUntilTasks);
}

function compiledChannel(channel: unknown): CompiledChannel<ChatSdkChannelState> {
  if (!isCompiledChannel(channel)) throw new Error("Expected a compiled Photon channel.");
  return channel;
}

class TestPhotonAdapter implements Adapter<string, unknown> {
  readonly name = "imessage";
  readonly userName = "eve";
  private chat: ChatInstance | null = null;

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
  }

  async handleWebhook(request: Request, options?: WebhookOptions): Promise<Response> {
    const messageId = parseMessageId(await request.json());
    await this.chat?.processMessage(this, THREAD_ID, inboundMessage(messageId), options);
    return new Response("ok");
  }

  channelIdFromThreadId(threadId: string): string {
    return threadId;
  }

  decodeThreadId(threadId: string): string {
    return threadId;
  }

  encodeThreadId(threadId: string): string {
    return threadId;
  }

  getChannelVisibility(): "private" {
    return "private";
  }

  isDM(): boolean {
    return true;
  }

  parseMessage(): Message {
    return inboundMessage("parsed-message-id");
  }

  renderFormatted(_content: FormattedContent): string {
    return "";
  }

  async fetchMessages(): Promise<FetchResult<unknown>> {
    return { messages: [] };
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    return {
      channelId: threadId,
      channelVisibility: "private",
      id: threadId,
      isDM: true,
      metadata: {},
    };
  }

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<unknown>> {
    return { id: "posted", raw: message, threadId };
  }

  async editMessage(
    threadId: string,
    messageId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<unknown>> {
    return { id: messageId, raw: message, threadId };
  }

  async addReaction(): Promise<void> {}
  async deleteMessage(): Promise<void> {}
  async markRead(): Promise<void> {}
  async removeReaction(): Promise<void> {}
  async startTyping(): Promise<void> {}
}

function parseMessageId(value: unknown): string {
  if (typeof value !== "object" || value === null || !("messageId" in value)) {
    throw new Error("Expected a messageId.");
  }
  if (typeof value.messageId !== "string") throw new Error("Expected a string messageId.");
  return value.messageId;
}

function inboundMessage(id: string): Message {
  return new Message({
    author: {
      fullName: "Test Sender",
      isBot: false,
      isMe: false,
      userId: "+15551234567",
      userName: "+15551234567",
    },
    formatted: parseMarkdown("hello"),
    id,
    raw: { id },
    text: "hello",
    threadId: THREAD_ID,
  });
}

class SharedStateAdapter implements StateAdapter {
  private readonly dedupeTtls: number[];
  private readonly subscriptions = new Set<string>();
  private readonly values: Map<string, unknown>;

  constructor(values: Map<string, unknown>, dedupeTtls: number[]) {
    this.values = values;
    this.dedupeTtls = dedupeTtls;
  }

  async acquireLock(threadId: string, ttlMs: number) {
    return { expiresAt: Date.now() + ttlMs, threadId, token: "lock" };
  }

  async appendToList(): Promise<void> {}
  async connect(): Promise<void> {}

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async dequeue(): Promise<QueueEntry | null> {
    return null;
  }

  async disconnect(): Promise<void> {}
  async enqueue(): Promise<number> {
    return 1;
  }
  async extendLock(): Promise<boolean> {
    return true;
  }
  async forceReleaseLock(): Promise<void> {}
  async get<T = unknown>(): Promise<T | null> {
    return null;
  }
  async getList<T = unknown>(): Promise<T[]> {
    return [];
  }
  async isSubscribed(threadId: string): Promise<boolean> {
    return this.subscriptions.has(threadId);
  }
  async queueDepth(): Promise<number> {
    return 0;
  }
  async releaseLock(): Promise<void> {}

  async set(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }

  async setIfNotExists(key: string, value: unknown, ttlMs?: number): Promise<boolean> {
    if (ttlMs !== undefined) this.dedupeTtls.push(ttlMs);
    if (this.values.has(key)) return false;
    this.values.set(key, value);
    return true;
  }

  async subscribe(threadId: string): Promise<void> {
    this.subscriptions.add(threadId);
  }

  async unsubscribe(threadId: string): Promise<void> {
    this.subscriptions.delete(threadId);
  }
}
