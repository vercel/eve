import { describe, expect, it, vi } from "vitest";

import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler, type ChannelAdapter } from "#channel/adapter.js";
import { isCompiledChannel, type CompiledChannel } from "#channel/compiled-channel.js";
import { isHttpRouteDefinition } from "#channel/routes.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import { chatSdkChannel, type ChatSdkChannelState } from "#public/channels/chat-sdk/index.js";
import type { RouteHandlerArgs, SendFn } from "#public/definitions/defineChannel.js";
import type {
  Adapter,
  AdapterPostableMessage,
  ChatInstance,
  FetchResult,
  FormattedContent,
  MessageMetadata,
  RawMessage,
  StateAdapter,
  Thread,
  ThreadInfo,
  WebhookOptions,
} from "#compiled/chat/index.js";
import { Message, parseMarkdown } from "#compiled/chat/index.js";

const THREAD_ID = "test:C01:1700000000.000001";
const CHANNEL_ID = "test:C01";

const AUTH = {
  attributes: {},
  authenticator: "test",
  principalId: "user-1",
  principalType: "user",
} as const;

function asCompiled<T = unknown>(channel: unknown): CompiledChannel<T> {
  if (!isCompiledChannel(channel)) {
    throw new Error("Expected a CompiledChannel.");
  }
  return channel as CompiledChannel<T>;
}

function getAdapter(channel: unknown): ChannelAdapter<any> {
  return asCompiled(channel).adapter;
}

function withState(adapter: ChannelAdapter<any>, state: ChatSdkChannelState): ChannelAdapter<any> {
  return { ...adapter, state };
}

function stubAccessor() {
  return { get: () => undefined, set: () => {} } as any;
}

const stubAlsContext = (() => {
  const ctx = new ContextContainer();
  ctx.setVirtualContext(SessionKey, {
    sessionId: "test-session",
    auth: { current: null, initiator: null },
    turn: { id: "test-turn", sequence: 0 },
  });
  return ctx;
})();

function callEvent(
  adapter: ChannelAdapter,
  event: HandleMessageStreamEvent,
  ctx: any,
): Promise<HandleMessageStreamEvent> {
  return contextStorage.run(stubAlsContext, () => callAdapterEventHandler(adapter, event, ctx));
}

function makeEvent<T extends HandleMessageStreamEvent["type"]>(
  type: T,
  data: unknown,
): HandleMessageStreamEvent {
  return { type, data } as HandleMessageStreamEvent;
}

async function firePost(
  channel: unknown,
  path: string,
  body: Record<string, unknown>,
): Promise<{
  response: Response;
  send: ReturnType<typeof vi.fn<SendFn<ChatSdkChannelState>>>;
  waitUntil: ReturnType<typeof vi.fn>;
}> {
  const compiled = asCompiled<ChatSdkChannelState>(channel);
  const post = compiled.routes.find((route) => route.method === "POST" && route.path === path);
  if (!post || !isHttpRouteDefinition(post)) {
    throw new Error(`Expected POST ${path}.`);
  }
  const send = vi.fn<SendFn<ChatSdkChannelState>>().mockResolvedValue({
    continuationToken: "chat-sdk:test",
    id: "session-1",
    async getEventStream() {
      return new ReadableStream();
    },
  });
  const waitUntil = vi.fn();

  const response = await post.handler(
    new Request(`https://example.com${path}`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
    {
      getSession: vi.fn() as any,
      params: {},
      receive: vi.fn() as any,
      requestIp: null,
      send,
      waitUntil,
    } satisfies RouteHandlerArgs<ChatSdkChannelState>,
  );

  let drained = 0;
  while (drained < waitUntil.mock.calls.length) {
    const pending = waitUntil.mock.calls.slice(drained).map(([task]) => task as Promise<unknown>);
    drained = waitUntil.mock.calls.length;
    await Promise.allSettled(pending);
  }

  return { response, send, waitUntil };
}

describe("chatSdkChannel", () => {
  it("mounts one webhook route per Chat SDK adapter", () => {
    const bridge = chatSdkChannel({
      adapters: {
        test: testAdapter(),
      },
      state: memoryState(),
      userName: "bot",
    });

    expect(
      bridge.channel.routes.map((route) => ({ method: route.method, path: route.path })),
    ).toEqual([{ method: "POST", path: "/eve/v1/chat/test" }]);
  });

  it("hands Chat SDK mentions to Eve through bridge.send", async () => {
    const adapter = testAdapter();
    const bridge = chatSdkChannel({
      adapters: { test: adapter },
      concurrency: "concurrent",
      state: memoryState(),
      userName: "bot",
    });

    bridge.bot.onNewMention(async (thread: Thread, message: Message) => {
      await bridge.send(message.text, { auth: AUTH, thread, title: "mention" });
    });

    const { response, send } = await firePost(bridge.channel, "/eve/v1/chat/test", {
      text: "@bot hello",
    });

    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBe("@bot hello");
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      auth: AUTH,
      continuationToken: THREAD_ID,
      state: {
        thread: {
          _type: "chat:Thread",
          adapterName: "test",
          channelId: CHANNEL_ID,
          id: THREAD_ID,
        },
      },
      title: "mention",
    });
  });

  it("fails loudly when bridge.send is called outside a Chat SDK webhook", async () => {
    const bridge = chatSdkChannel({
      adapters: { test: testAdapter() },
      state: memoryState(),
      userName: "bot",
    });

    await expect(
      bridge.send("hello", {
        auth: null,
        adapterName: "test",
        thread: THREAD_ID,
      }),
    ).rejects.toThrow("chatSdkChannel().send can only run during a Chat SDK webhook handler");
  });

  it("supports proactive receive with a thread id target", async () => {
    const bridge = chatSdkChannel({
      adapters: { test: testAdapter() },
      state: memoryState(),
      userName: "bot",
    });
    const send = vi.fn<SendFn<ChatSdkChannelState>>().mockResolvedValue({
      continuationToken: "chat-sdk:test",
      id: "session-1",
      async getEventStream() {
        return new ReadableStream();
      },
    });

    await bridge.channel.receive?.(
      {
        auth: AUTH,
        message: "proactive",
        target: { adapterName: "test", threadId: THREAD_ID },
      },
      { send },
    );

    expect(send).toHaveBeenCalledWith("proactive", {
      auth: AUTH,
      continuationToken: THREAD_ID,
      state: {
        thread: {
          _type: "chat:Thread",
          adapterName: "test",
          channelId: CHANNEL_ID,
          channelVisibility: "workspace",
          id: THREAD_ID,
          isDM: false,
        },
      },
    });
  });

  it("posts completed Eve messages through the stored Chat SDK thread", async () => {
    const adapter = testAdapter();
    const bridge = chatSdkChannel({
      adapters: { test: adapter },
      state: memoryState(),
      userName: "bot",
    });
    const channelAdapter = withState(getAdapter(bridge.channel), {
      thread: serializedThread(),
    });
    const ctx = buildAdapterContext(channelAdapter, stubAccessor());

    await callEvent(
      channelAdapter,
      makeEvent("message.completed", {
        finishReason: "stop",
        message: "done",
        sequence: 1,
        stepIndex: 0,
        turnId: "turn-1",
      }),
      ctx,
    );

    expect(adapter.posted).toEqual([
      {
        message: "done",
        threadId: THREAD_ID,
      },
    ]);
  });

  it("renders input requests as Chat SDK cards and resumes on button actions", async () => {
    const adapter = testAdapter();
    const bridge = chatSdkChannel({
      adapters: { test: adapter },
      concurrency: "concurrent",
      state: memoryState(),
      userName: "bot",
    });
    const channelAdapter = withState(getAdapter(bridge.channel), {
      thread: serializedThread(),
    });
    const ctx = buildAdapterContext(channelAdapter, stubAccessor());

    await callEvent(
      channelAdapter,
      makeEvent("input.requested", {
        requests: [
          {
            action: { callId: "call-1", name: "deploy", type: "tool-call" },
            display: "confirmation",
            options: [
              { id: "approve", label: "Approve", style: "primary" },
              { id: "deny", label: "Deny", style: "danger" },
            ],
            prompt: "Deploy?",
            requestId: "request-1",
          },
        ],
        sequence: 1,
        stepIndex: 0,
        turnId: "turn-1",
      }),
      ctx,
    );

    const card = adapter.posted[0]?.message as AdapterPostableMessage;
    expect(card).toMatchObject({
      children: [
        { content: "Deploy?", type: "text" },
        {
          children: [
            {
              id: "eve_input:request-1:approve",
              label: "Approve",
              style: "primary",
              type: "button",
              value: "approve",
            },
            {
              id: "eve_input:request-1:deny",
              label: "Deny",
              style: "danger",
              type: "button",
              value: "deny",
            },
          ],
          type: "actions",
        },
      ],
      type: "card",
    });

    const { send } = await firePost(bridge.channel, "/eve/v1/chat/test", {
      actionId: "eve_input:request-1:approve",
      kind: "action",
      value: "approve",
    });

    expect(send).toHaveBeenCalledWith(
      { inputResponses: [{ optionId: "approve", requestId: "request-1" }] },
      {
        auth: null,
        continuationToken: THREAD_ID,
        state: {
          thread: expect.objectContaining({
            adapterName: "test",
            id: THREAD_ID,
          }),
        },
      },
    );
  });
});

function testAdapter(): TestAdapter & Adapter {
  return new TestAdapter() as TestAdapter & Adapter;
}

class TestAdapter {
  readonly name = "test";
  readonly userName = "bot";
  chat: ChatInstance | null = null;
  posted: Array<{ message: AdapterPostableMessage; threadId: string }> = [];

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
  }

  async handleWebhook(request: Request, options?: WebhookOptions): Promise<Response> {
    const body = (await request.json()) as {
      actionId?: string;
      kind?: string;
      text?: string;
      value?: string;
    };
    if (body.kind === "action") {
      const adapter = this as Adapter;
      await this.chat?.processAction(
        {
          actionId: body.actionId ?? "",
          adapter,
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

    const adapter = this as Adapter;
    await this.chat?.processMessage(
      adapter,
      THREAD_ID,
      message(body.text ?? "@bot hello"),
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
    return message(raw.text ?? "");
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
    this.posted.push({ message: posted, threadId });
    return {
      id: `posted-${this.posted.length}`,
      raw: posted,
      threadId,
    };
  }

  async editMessage(
    threadId: string,
    _messageId: string,
    posted: AdapterPostableMessage,
  ): Promise<RawMessage> {
    return {
      id: "edited",
      raw: posted,
      threadId,
    };
  }

  async addReaction(): Promise<void> {}
  async deleteMessage(): Promise<void> {}
  async removeReaction(): Promise<void> {}
  async startTyping(): Promise<void> {}
}

function message(text: string): Message {
  return new Message({
    attachments: [],
    author: author(),
    formatted: parseMarkdown(text),
    id: "message-1",
    isMention: true,
    metadata: metadata(),
    raw: { text },
    text,
    threadId: THREAD_ID,
  });
}

function serializedThread() {
  return {
    _type: "chat:Thread",
    adapterName: "test",
    channelId: CHANNEL_ID,
    channelVisibility: "workspace",
    id: THREAD_ID,
    isDM: false,
  } as const;
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

function metadata(): MessageMetadata {
  return { dateSent: new Date("2026-01-01T00:00:00.000Z"), edited: false };
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
