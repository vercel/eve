import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { Message as ExternalMessage, Thread as ExternalThread } from "chat";

import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler, type ChannelAdapter } from "#channel/adapter.js";
import { isCompiledChannel, type CompiledChannel } from "#channel/compiled-channel.js";
import { isHttpRouteDefinition } from "#channel/routes.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { enterSessionProjection, recordPublishedEvent } from "#harness/session-machine/current.js";
import { SessionKey } from "#context/keys.js";
import { mockChannelContext } from "#internal/testing/mocks/mock-channel-operations.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import {
  chatSdkChannel,
  isNotImplemented,
  messageToUserContent,
  type ChatSdkChannelState,
} from "#public/channels/chat-sdk/index.js";
import type { RouteHandlerArgs } from "#public/definitions/channel.js";
import type {
  Adapter,
  AdapterPostableMessage,
  Attachment,
  ChatInstance,
  EphemeralMessage,
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
import { mockAgentRouteArgs } from "#internal/testing/mocks/mock-route-args.js";

it("shares Chat SDK type identity with external adapters and handlers", () => {
  expectTypeOf<Message>().toEqualTypeOf<ExternalMessage>();
  expectTypeOf<Thread>().toEqualTypeOf<ExternalThread>();
});

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
  const accessor = { get: () => undefined, set: () => {} } as any;
  // A step enters its projection before it publishes.
  enterSessionProjection(accessor, undefined);
  return accessor;
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
  event: UnstampedMessageStreamEvent,
  ctx: any,
): Promise<UnstampedMessageStreamEvent> {
  return contextStorage.run(stubAlsContext, () => callAdapterEventHandler(adapter, event, ctx));
}

/** Delivers `event` as a session publishes it: the handler runs, then the session records it. */
async function publishEvent(adapter: ChannelAdapter, event: UnstampedMessageStreamEvent, ctx: any) {
  await callEvent(adapter, event, ctx);
  recordPublishedEvent(ctx.ctx, event);
}

function makeEvent<T extends UnstampedMessageStreamEvent["type"]>(
  type: T,
  data: unknown,
): UnstampedMessageStreamEvent {
  return { type, data } as UnstampedMessageStreamEvent;
}

async function firePost(
  channel: unknown,
  path: string,
  body: Record<string, unknown>,
): Promise<{
  cancel: ReturnType<typeof vi.fn>;
  response: Response;
  send: ReturnType<typeof vi.fn>;
  waitUntil: ReturnType<typeof vi.fn>;
}> {
  const compiled = asCompiled<ChatSdkChannelState>(channel);
  const post = compiled.routes.find((route) => route.method === "POST" && route.path === path);
  if (!post || !isHttpRouteDefinition(post)) {
    throw new Error(`Expected POST ${path}.`);
  }
  const send = vi.fn().mockResolvedValue({ id: "session-1" });
  const cancel = vi.fn().mockResolvedValue({ sessionId: "session-1", status: "accepted" });
  const waitUntil = vi.fn();
  const channelContext = mockChannelContext<ChatSdkChannelState>(send);

  const response = await post.handler(
    new Request(`https://example.com${path}`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
    {
      ...mockAgentRouteArgs(),
      from(continuationToken) {
        return {
          ...channelContext.from(continuationToken),
          cancel: () => cancel({ continuationToken }) as never,
        };
      },
      resolveSession: channelContext.resolveSession,
      attachSession: vi.fn() as any,
      params: {},
      to: vi.fn() as any,
      requestIp: null,
      waitUntil,
    } satisfies RouteHandlerArgs<ChatSdkChannelState>,
  );

  let drained = 0;
  while (drained < waitUntil.mock.calls.length) {
    const pending = waitUntil.mock.calls.slice(drained).map(([task]) => task as Promise<unknown>);
    drained = waitUntil.mock.calls.length;
    await Promise.allSettled(pending);
  }

  return { cancel, response, send, waitUntil };
}

function bridgeSendTypeChecks(bridge: ReturnType<typeof chatSdkChannel>, thread: Thread): void {
  // @ts-expect-error bridge.send takes a message; answer input with bridge.respond.
  void bridge.send({ inputResponses: [{ optionId: "approve", requestId: "r1" }] }, { thread });
  void bridge.send("hello", { context: ["extra"], outputSchema: { type: "object" }, thread });
}

void bridgeSendTypeChecks;

describe("chatSdkChannel", () => {
  it.each([
    [{ isDM: true, channelVisibility: "unknown" }, "private"],
    [{ isDM: false, channelVisibility: "workspace" }, "public"],
    [{ isDM: false, channelVisibility: "private" }, "private"],
  ] as const)("classifies the $audience audience", (thread, audience) => {
    const bridge = chatSdkChannel({
      adapters: { test: testAdapter() },
      state: memoryState(),
      userName: "bot",
    });
    const adapter = getAdapter(bridge.channel);
    if (!adapter.state) throw new Error("Expected Chat SDK state.");
    adapter.state.thread = {
      _type: "chat:Thread",
      adapterName: "test",
      channelId: CHANNEL_ID,
      id: THREAD_ID,
      ...thread,
    };

    expect(
      adapter.instrumentation?.audience?.({
        auth: null,
        caller: { type: "anonymous" },
        channel: { kind: "channel:chat-sdk" },
        environment: "production",
        state: adapter.state,
      }),
    ).toBe(audience);
  });

  it("mounts GET and POST webhook routes per Chat SDK adapter", () => {
    const bridge = chatSdkChannel({
      adapters: {
        test: testAdapter(),
      },
      state: memoryState(),
      userName: "bot",
    });

    expect(
      bridge.channel.routes.map((route) => ({ method: route.method, path: route.path })),
    ).toEqual([
      { method: "GET", path: "/eve/v1/test" },
      { method: "POST", path: "/eve/v1/test" },
    ]);
  });

  it("routes GET verification challenges to the adapter webhook", async () => {
    const bridge = chatSdkChannel({
      adapters: { test: testAdapter() },
      state: memoryState(),
      // Tests that initialize Chat SDK keep its warnings but not its info-level startup lines.
      logger: "warn",
      userName: "bot",
    });
    const compiled = asCompiled<ChatSdkChannelState>(bridge.channel);
    const get = compiled.routes.find(
      (route) => route.method === "GET" && route.path === "/eve/v1/test",
    );
    if (!get || !isHttpRouteDefinition(get)) {
      throw new Error("Expected GET /eve/v1/test.");
    }

    const response = await get.handler(
      new Request("https://example.com/eve/v1/test?crc_token=abc123", { method: "GET" }),
      {
        ...mockAgentRouteArgs(),
        ...mockChannelContext(vi.fn()),
        attachSession: vi.fn() as any,
        params: {},
        to: vi.fn() as any,
        requestIp: null,
        waitUntil: vi.fn(),
      } satisfies RouteHandlerArgs<ChatSdkChannelState>,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ response_token: "sha256=abc123" });
  });

  it("hands Chat SDK mentions to eve through bridge.send", async () => {
    const adapter = testAdapter();
    const bridge = chatSdkChannel({
      adapters: { test: adapter },
      concurrency: "concurrent",
      state: memoryState(),
      logger: "warn",
      userName: "bot",
    });

    bridge.bot.onNewMention(async (thread: Thread, message: Message) => {
      await bridge.send(message.text, {
        auth: AUTH,
        thread,
        title: "mention",
      });
    });

    const { cancel, response, send } = await firePost(bridge.channel, "/eve/v1/test", {
      text: "@bot hello",
    });

    expect(response.status).toBe(200);
    expect(cancel).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBe(THREAD_ID);
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      auth: AUTH,
      message: "@bot hello",
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

  it("carries a steering send on the shared delivery", async () => {
    const bridge = chatSdkChannel({
      adapters: { test: testAdapter() },
      concurrency: "concurrent",
      state: memoryState(),
      logger: "warn",
      userName: "bot",
    });

    bridge.bot.onNewMention(async (thread: Thread, message: Message) => {
      await bridge.send(message.text, {
        auth: AUTH,
        thread,
        turnPolicy: "steer",
      });
    });

    const { cancel, response, send } = await firePost(bridge.channel, "/eve/v1/test", {
      text: "@bot correction",
    });

    expect(response.status).toBe(200);
    expect(cancel).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(THREAD_ID, {
      auth: AUTH,
      message: "@bot correction",
      state: {
        thread: expect.objectContaining({
          adapterName: "test",
          id: THREAD_ID,
        }),
      },
      turnPolicy: "steer",
    });
  });

  it("answers pending input through bridge.respond without cancelling", async () => {
    const bridge = chatSdkChannel({
      adapters: { test: testAdapter() },
      concurrency: "concurrent",
      state: memoryState(),
      logger: "warn",
      userName: "bot",
    });

    bridge.bot.onNewMention(async (thread: Thread) => {
      await bridge.respond([{ optionId: "approve", requestId: "request-1" }], { thread });
    });

    const { cancel, response, send } = await firePost(bridge.channel, "/eve/v1/test", {
      text: "@bot approve",
    });

    expect(response.status).toBe(200);
    expect(cancel).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      THREAD_ID,
      expect.objectContaining({
        inputResponses: [{ optionId: "approve", requestId: "request-1" }],
      }),
    );
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
    const send = vi.fn().mockResolvedValue({ id: "session-1" });

    await bridge.channel.receive?.(
      {
        auth: AUTH,
        message: "proactive",
        target: { adapterName: "test", threadId: THREAD_ID },
      },
      mockChannelContext(send),
    );

    expect(send).toHaveBeenCalledWith(THREAD_ID, {
      auth: AUTH,
      message: "proactive",
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

  it("posts completed eve messages as markdown through the stored Chat SDK thread", async () => {
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
        message: { markdown: "done" },
        threadId: THREAD_ID,
      },
    ]);
  });

  it("renders an authorization challenge in a direct-message thread and updates it on completion", async () => {
    const adapter = testAdapter();
    const bridge = chatSdkChannel({
      adapters: { test: adapter },
      state: memoryState(),
      userName: "bot",
    });
    const state: ChatSdkChannelState = { thread: serializedThread({ isDM: true }) };
    const channelAdapter = withState(getAdapter(bridge.channel), state);
    const ctx = buildAdapterContext(channelAdapter, stubAccessor());

    await callEvent(
      channelAdapter,
      makeEvent("authorization.required", {
        authorization: {
          displayName: "Notion Workspace",
          instructions: "Choose a workspace.",
          url: "https://connect.example.com/a/sca_1",
          userCode: "ABC-123",
        },
        name: "notion",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn-1",
      }),
      ctx,
    );

    expect(adapter.posted).toEqual([
      {
        message: {
          markdown:
            "Authorization required for Notion Workspace.\n\nChoose a workspace.\n\nCode: ABC-123\n\nhttps://connect.example.com/a/sca_1",
        },
        threadId: THREAD_ID,
      },
    ]);
    expect(state.pendingAuthMessageIds).toEqual({ notion: "posted-1" });

    await callEvent(
      channelAdapter,
      makeEvent("authorization.completed", {
        authorization: { displayName: "Notion Workspace" },
        name: "notion",
        outcome: "authorized",
        sequence: 1,
        stepIndex: 0,
        turnId: "turn-1",
      }),
      ctx,
    );

    expect(adapter.edited).toEqual([
      {
        message: { markdown: "Notion Workspace connected." },
        messageId: "posted-1",
        threadId: THREAD_ID,
      },
    ]);
    expect(state.pendingAuthMessageIds).toEqual({});
  });

  it("keeps authorization challenges link-free outside direct messages", async () => {
    const adapter = testAdapter();
    const bridge = chatSdkChannel({
      adapters: { test: adapter },
      state: memoryState(),
      userName: "bot",
    });
    const channelAdapter = withState(getAdapter(bridge.channel), { thread: serializedThread() });
    const ctx = buildAdapterContext(channelAdapter, stubAccessor());

    await callEvent(
      channelAdapter,
      makeEvent("authorization.required", {
        authorization: { url: "https://connect.example.com/a/sca_1", userCode: "ABC-123" },
        name: "notion",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn-1",
      }),
      ctx,
    );

    expect(adapter.posted).toEqual([
      {
        message: {
          markdown:
            "Authorization required for Notion. Continue in a direct message with this agent.",
        },
        threadId: THREAD_ID,
      },
    ]);
  });

  describe("a sign-in outside a direct message", () => {
    const signIn = makeEvent("authorization.required", {
      authorization: { url: "https://connect.example.com/a/sca_1", userCode: "ABC-123" },
      name: "notion",
      principalId: AUTH.principalId,
      sequence: 0,
      stepIndex: 0,
      turnId: "turn-1",
    });
    const PRIVATE_STATUS =
      "Authorization required for Notion. I sent you the sign-in details privately.";
    const DM_NOTICE =
      "Authorization required for Notion. Continue in a direct message with this agent.";
    const alice = author();
    const bob = { ...author(), fullName: "Bob", userId: "user-2", userName: "bob" };

    /** Delivers a message from `from`, sent as `caller`, then raises the sign-in. */
    async function signInAfter(
      adapter: TestAdapter & Adapter,
      messages: ReadonlyArray<{
        readonly caller: typeof AUTH | null;
        readonly from?: Message["author"];
      }>,
    ) {
      const bridge = chatSdkChannel({
        adapters: { test: adapter },
        state: memoryState(),
        userName: "bot",
      });
      const state: ChatSdkChannelState = { thread: serializedThread() };
      const channelAdapter = withState(getAdapter(bridge.channel), state);
      const ctx = buildAdapterContext(channelAdapter, stubAccessor());
      for (const { caller, from } of messages) {
        const currentMessage = from === undefined ? undefined : message("hi", from).toJSON();
        await channelAdapter.deliver!(
          { message: "hi", state: { thread: { ...serializedThread(), currentMessage } } },
          { ...ctx, session: { auth: { current: caller, initiator: caller } } } as never,
        );
      }
      await callEvent(channelAdapter, signIn, ctx);
      return adapter.posted.map(({ message: posted }) => posted);
    }

    it.each([
      {
        name: "shows the challenge only to the person signing in",
        postEphemeral: async () => ({
          id: "e1",
          threadId: THREAD_ID,
          usedFallback: false,
          raw: {},
        }),
        status: PRIVATE_STATUS,
      },
      {
        name: "points at a DM when the adapter can't deliver privately",
        postEphemeral: async () => null,
        status: DM_NOTICE,
      },
      {
        name: "points at a DM when the private delivery fails",
        postEphemeral: async () => {
          throw new Error("ephemeral failed");
        },
        status: DM_NOTICE,
      },
    ])("$name", async ({ postEphemeral, status }) => {
      const adapter = testAdapter();
      const ephemerals: Array<{ message: AdapterPostableMessage; userId: string }> = [];
      adapter.postEphemeral = async (_threadId, userId, posted) => {
        ephemerals.push({ message: posted, userId });
        return postEphemeral();
      };

      const posted = await signInAfter(adapter, [{ caller: AUTH, from: alice }]);

      expect(posted).toEqual([{ markdown: status }]);
      expect(ephemerals).toEqual([
        {
          message: {
            markdown:
              "Authorization required for Notion.\n\nCode: ABC-123\n\nhttps://connect.example.com/a/sca_1",
          },
          userId: alice.userId,
        },
      ]);
    });

    it.each([
      { name: "an anonymous sender", messages: [{ caller: null, from: alice }] },
      { name: "a bot author", messages: [{ caller: AUTH, from: { ...alice, isBot: true } }] },
      { name: "a send without its message", messages: [{ caller: AUTH }] },
      {
        name: "a principal two people send as",
        messages: [
          { caller: AUTH, from: alice },
          { caller: AUTH, from: bob },
        ],
      },
    ])("sends the challenge to no one after $name", async ({ messages }) => {
      const adapter = testAdapter();
      const ephemeral = vi.fn();
      adapter.postEphemeral = ephemeral;

      const posted = await signInAfter(adapter, messages);

      expect(posted).toEqual([{ markdown: DM_NOTICE }]);
      expect(ephemeral).not.toHaveBeenCalled();
    });
  });

  it("does not throw when the adapter's startTyping is not implemented", async () => {
    const adapter = testAdapter();
    adapter.startTypingError = new NotImplementedError("startTyping");
    const bridge = chatSdkChannel({
      adapters: { test: adapter },
      state: memoryState(),
      userName: "bot",
    });
    const channelAdapter = withState(getAdapter(bridge.channel), {
      thread: serializedThread(),
    });
    const ctx = buildAdapterContext(channelAdapter, stubAccessor());

    await expect(
      callEvent(channelAdapter, makeEvent("turn.started", { sequence: 0, turnId: "turn-1" }), ctx),
    ).resolves.toBeDefined();
    expect(adapter.typingStatuses).toEqual(["Working..."]);
  });

  it("streams assistant deltas by posting an anchor then editing it", async () => {
    const adapter = testAdapter();
    const bridge = chatSdkChannel({
      adapters: { test: adapter },
      state: memoryState(),
      streamingEditIntervalMs: 0,
      userName: "bot",
    });
    const state: ChatSdkChannelState = { thread: serializedThread() };
    const channelAdapter = withState(getAdapter(bridge.channel), state);
    const ctx = buildAdapterContext(channelAdapter, stubAccessor());

    await callEvent(
      channelAdapter,
      makeEvent("message.appended", {
        messageDelta: "Hel",
        sequence: 1,
        stepIndex: 0,
        turnId: "turn-1",
      }),
      ctx,
    );
    expect(adapter.posted).toEqual([{ message: { markdown: "Hel" }, threadId: THREAD_ID }]);
    expect(state.anchorMessageId).toBe("posted-1");

    await callEvent(
      channelAdapter,
      makeEvent("message.appended", {
        messageDelta: "lo",
        sequence: 2,
        stepIndex: 0,
        turnId: "turn-1",
      }),
      ctx,
    );
    expect(adapter.edited).toEqual([
      { message: { markdown: "Hello" }, messageId: "posted-1", threadId: THREAD_ID },
    ]);
  });

  it("finalizes a retried stream from the canonical completed message", async () => {
    const adapter = testAdapter();
    const bridge = chatSdkChannel({
      adapters: { test: adapter },
      state: memoryState(),
      streamingEditIntervalMs: 0,
      userName: "bot",
    });
    const state: ChatSdkChannelState = { thread: serializedThread() };
    const channelAdapter = withState(getAdapter(bridge.channel), state);
    const ctx = buildAdapterContext(channelAdapter, stubAccessor());

    for (const messageDelta of ["abandoned", "replacement"]) {
      await callEvent(
        channelAdapter,
        makeEvent("message.appended", {
          messageDelta,
          sequence: 1,
          stepIndex: 0,
          turnId: "turn-1",
        }),
        ctx,
      );
    }
    await callEvent(
      channelAdapter,
      makeEvent("message.completed", {
        finishReason: "stop",
        message: "replacement",
        sequence: 1,
        stepIndex: 0,
        turnId: "turn-1",
      }),
      ctx,
    );

    expect(adapter.edited.at(-1)).toEqual({
      message: { markdown: "replacement" },
      messageId: "posted-1",
      threadId: THREAD_ID,
    });
    expect(state.anchorMessageId).toBeNull();
  });

  it("falls back to a fresh post when streaming edits are not implemented", async () => {
    const adapter = testAdapter();
    adapter.editError = new NotImplementedError("editMessage");
    const bridge = chatSdkChannel({
      adapters: { test: adapter },
      state: memoryState(),
      userName: "bot",
    });
    const state: ChatSdkChannelState = {
      anchorMessageId: "posted-1",
      editSupported: true,
      streamStepIndex: 0,
      thread: serializedThread(),
    };
    const channelAdapter = withState(getAdapter(bridge.channel), state);
    const ctx = buildAdapterContext(channelAdapter, stubAccessor());

    await callEvent(
      channelAdapter,
      makeEvent("message.completed", {
        finishReason: "stop",
        message: "final answer",
        sequence: 2,
        stepIndex: 0,
        turnId: "turn-1",
      }),
      ctx,
    );

    expect(adapter.posted).toEqual([
      { message: { markdown: "final answer" }, threadId: THREAD_ID },
    ]);
    expect(state.editSupported).toBe(false);
  });

  it("finalizes the streamed anchor when a step completes with tool-calls", async () => {
    const adapter = testAdapter();
    const bridge = chatSdkChannel({
      adapters: { test: adapter },
      state: memoryState(),
      userName: "bot",
    });
    const state: ChatSdkChannelState = {
      anchorMessageId: "posted-1",
      editSupported: true,
      streamStepIndex: 0,
      thread: serializedThread(),
    };
    const channelAdapter = withState(getAdapter(bridge.channel), state);
    const ctx = buildAdapterContext(channelAdapter, stubAccessor());

    await callEvent(
      channelAdapter,
      makeEvent("message.completed", {
        finishReason: "tool-calls",
        message: "Let me check that.\nlooking now",
        sequence: 2,
        stepIndex: 0,
        turnId: "turn-1",
      }),
      ctx,
    );

    expect(adapter.edited).toEqual([
      {
        message: { markdown: "Let me check that.\nlooking now" },
        messageId: "posted-1",
        threadId: THREAD_ID,
      },
    ]);
    expect(adapter.posted).toEqual([]);
    expect(state.pendingToolCallMessage).toBe("Let me check that.");
    expect(state.anchorMessageId).toBeNull();
  });

  it("does not post intermediate tool-call narration when streaming is off", async () => {
    const adapter = testAdapter();
    const bridge = chatSdkChannel({
      adapters: { test: adapter },
      state: memoryState(),
      streaming: false,
      userName: "bot",
    });
    const state: ChatSdkChannelState = { thread: serializedThread() };
    const channelAdapter = withState(getAdapter(bridge.channel), state);
    const ctx = buildAdapterContext(channelAdapter, stubAccessor());

    await callEvent(
      channelAdapter,
      makeEvent("message.completed", {
        finishReason: "tool-calls",
        message: "Let me check that.",
        sequence: 1,
        stepIndex: 0,
        turnId: "turn-1",
      }),
      ctx,
    );

    expect(adapter.posted).toEqual([]);
    expect(adapter.edited).toEqual([]);
    expect(state.pendingToolCallMessage).toBe("Let me check that.");
  });

  it("renders input requests as Chat SDK cards with buttons and a text fallback naming each reply", async () => {
    const adapter = testAdapter();
    const bridge = chatSdkChannel({
      adapters: { test: adapter },
      concurrency: "concurrent",
      state: memoryState(),
      logger: "warn",
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
              { id: "cancel", label: "Cancel", style: "danger" },
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

    const posted = adapter.posted[0]?.message as AdapterPostableMessage;
    expect(posted).toMatchObject({
      card: {
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
                id: "eve_input:request-1:cancel",
                label: "Cancel",
                style: "danger",
                type: "button",
                value: "cancel",
              },
            ],
            type: "actions",
          },
        ],
        type: "card",
      },
      fallbackText: "Deploy?\n\n1. Approve\n2. Cancel\n\nReply with a number to choose.",
    });
  });

  it("asks for a typed reply when an input request accepts a freeform answer", async () => {
    const adapter = testAdapter();
    const bridge = chatSdkChannel({
      adapters: { test: adapter },
      concurrency: "concurrent",
      state: memoryState(),
      logger: "warn",
      userName: "bot",
    });
    const channelAdapter = withState(getAdapter(bridge.channel), {
      thread: serializedThread(),
    });
    const accessor = stubAccessor();
    const ctx = buildAdapterContext(channelAdapter, accessor);
    // The channel reads the session's record of what it published.
    enterSessionProjection(accessor, undefined);

    await publishEvent(
      channelAdapter,
      makeEvent("input.requested", {
        requests: [
          {
            action: { callId: "call-1", name: "ask", type: "tool-call" },
            display: "text",
            prompt: "Which region?",
            requestId: "request-1",
          },
          {
            action: { callId: "call-2", name: "ask", type: "tool-call" },
            allowFreeform: true,
            display: "select",
            options: [{ id: "iad1", label: "Washington" }],
            prompt: "Which zone?",
            requestId: "request-2",
          },
        ],
        sequence: 1,
        stepIndex: 0,
        turnId: "turn-1",
      }),
      ctx,
    );

    expect(adapter.posted.map(({ message }) => message)).toMatchObject([
      {
        card: {
          children: [
            { content: "Which region?", type: "text" },
            { content: "Reply with your answer.", type: "text" },
          ],
        },
        fallbackText: "Which region?\n\nReply with your answer.",
      },
    ]);

    // A reply can only answer the request it sees, so the next one waits its turn.
    await publishEvent(
      channelAdapter,
      makeEvent("input.resolved", {
        resolutions: [{ kind: "question", outcome: "answered", requestId: "request-1" }],
        sequence: 1,
        stepIndex: 0,
        turnId: "turn-1",
      }),
      ctx,
    );
    expect(adapter.posted.at(-1)?.message).toMatchObject({
      card: {
        children: [
          { content: "Which zone?", type: "text" },
          { type: "actions" },
          { content: "Or reply with your own answer.", type: "text" },
        ],
      },
      fallbackText: "Which zone?\n\n1. Washington\n\nReply with a number, or with your own answer.",
    });
  });
});

describe("messageToUserContent", () => {
  it("returns the plain text when there are no attachments", () => {
    expect(messageToUserContent(message("just text"))).toBe("just text");
  });

  it("builds text and file parts when attachments have URLs", () => {
    const withAttachment = new Message({
      attachments: [
        {
          mimeType: "application/pdf",
          name: "a.pdf",
          type: "file",
          url: "https://example.com/a.pdf",
        },
      ],
      author: author(),
      formatted: parseMarkdown("see attached"),
      id: "message-2",
      isMention: true,
      metadata: metadata(),
      raw: { text: "see attached" },
      text: "see attached",
      threadId: THREAD_ID,
    });

    const content = messageToUserContent(withAttachment);
    expect(Array.isArray(content)).toBe(true);
    const parts = content as Exclude<typeof content, string>;
    expect(parts[0]).toEqual({ text: "see attached", type: "text" });
    expect(parts[1]).toMatchObject({
      filename: "a.pdf",
      mediaType: "application/pdf",
      type: "file",
    });
    expect((parts[1] as { data: URL }).data.href).toBe("https://example.com/a.pdf");
  });

  it("skips attachments without a URL, keeping the text part", () => {
    const withUrllessAttachment = new Message({
      attachments: [{ name: "pasted", type: "image" }],
      author: author(),
      formatted: parseMarkdown("no url"),
      id: "message-3",
      isMention: true,
      metadata: metadata(),
      raw: { text: "no url" },
      text: "no url",
      threadId: THREAD_ID,
    });

    expect(messageToUserContent(withUrllessAttachment)).toEqual([{ text: "no url", type: "text" }]);
  });

  it("falls back to text when there are no usable parts", () => {
    const emptyWithUrllessAttachment = new Message({
      attachments: [{ name: "pasted", type: "image" }],
      author: author(),
      formatted: parseMarkdown(""),
      id: "message-4",
      isMention: true,
      metadata: metadata(),
      raw: { text: "" },
      text: "",
      threadId: THREAD_ID,
    });

    expect(messageToUserContent(emptyWithUrllessAttachment)).toBe("");
  });
});

describe("attachments the adapter downloads", () => {
  function withDownload(fetchData: () => Promise<Buffer>, size?: number): Message {
    return new Message({
      attachments: [
        {
          fetchData,
          fetchMetadata: { fileId: "F1" },
          mimeType: "image/png",
          name: "diagram.png",
          size,
          type: "image",
          url: "https://files.test/F1",
        },
      ],
      author: author(),
      formatted: parseMarkdown(""),
      id: "message-5",
      isMention: true,
      metadata: metadata(),
      raw: {},
      text: "",
      threadId: THREAD_ID,
    });
  }

  /** The channel's `fetchFile` for the one file part `messageToUserContent` made. */
  async function fetchDeferred(adapter: TestAdapter & Adapter, inbound: Message) {
    const bridge = chatSdkChannel({
      adapters: { test: adapter },
      state: memoryState(),
      userName: "bot",
    });
    const [part] = messageToUserContent(inbound) as Exclude<
      ReturnType<typeof messageToUserContent>,
      string
    >;
    // Only the URL crosses the queue; the message's own fetchData doesn't.
    const href = ((part as { data: URL }).data as URL).href;
    return await getAdapter(bridge.channel).fetchFile!(href);
  }

  it("defers the download to the step and rebuilds it with the adapter's rehydrateAttachment", async () => {
    const adapter = testAdapter();
    adapter.rehydrateAttachment = (attachment) => ({
      ...attachment,
      fetchData: async () => Buffer.from(`bytes of ${String(attachment.fetchMetadata?.fileId)}`),
    });
    const fetchData = vi.fn(async () => Buffer.from("eager"));

    const resolved = await fetchDeferred(adapter, withDownload(fetchData));

    expect(fetchData).not.toHaveBeenCalled();
    expect(resolved).toEqual({ bytes: Buffer.from("bytes of F1"), mediaType: "image/png" });
  });

  it("fails a download over the upload limit", async () => {
    const adapter = testAdapter();
    adapter.rehydrateAttachment = (attachment) => ({
      ...attachment,
      fetchData: async () => Buffer.alloc(25 * 1024 * 1024 + 1),
    });

    await expect(
      fetchDeferred(
        adapter,
        withDownload(async () => Buffer.alloc(0)),
      ),
    ).rejects.toThrow("it is over the 25 MB upload limit.");
  });

  it("notes a file the adapter reports as over the limit without deferring it", () => {
    expect(
      messageToUserContent(withDownload(async () => Buffer.alloc(0), 25 * 1024 * 1024 + 1)),
    ).toEqual([
      {
        text: "Attachment diagram.png was not retrieved: it is over the upload limit.",
        type: "text",
      },
    ]);
  });

  it("fails the download when the adapter can't rebuild it after the webhook", async () => {
    await expect(
      fetchDeferred(
        testAdapter(),
        withDownload(async () => Buffer.alloc(0)),
      ),
    ).rejects.toThrow("the test adapter can't download it after the webhook returns.");
  });
});

describe("isNotImplemented", () => {
  it("matches errors by name and by code", () => {
    expect(isNotImplemented(new NotImplementedError("startTyping"))).toBe(true);
    expect(isNotImplemented(Object.assign(new Error("nope"), { code: "NOT_IMPLEMENTED" }))).toBe(
      true,
    );
  });

  it("ignores unrelated errors and non-errors", () => {
    expect(isNotImplemented(new Error("boom"))).toBe(false);
    expect(isNotImplemented("NOT_IMPLEMENTED")).toBe(false);
    expect(isNotImplemented(null)).toBe(false);
  });
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

class TestAdapter {
  readonly name = "test";
  readonly userName = "bot";
  chat: ChatInstance | null = null;
  posted: Array<{ message: AdapterPostableMessage; threadId: string }> = [];
  edited: Array<{ message: AdapterPostableMessage; messageId: string; threadId: string }> = [];
  typingStatuses: Array<string | undefined> = [];
  startTypingError: Error | null = null;
  editError: Error | null = null;
  rehydrateAttachment?: (attachment: Attachment) => Attachment;
  /** Native ephemerals, when a test gives the adapter them. */
  postEphemeral?: (
    threadId: string,
    userId: string,
    message: AdapterPostableMessage,
  ) => Promise<EphemeralMessage | null>;

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
  }

  async handleWebhook(request: Request, options?: WebhookOptions): Promise<Response> {
    if (request.method === "GET") {
      const crcToken = new URL(request.url).searchParams.get("crc_token");
      return Response.json({ response_token: `sha256=${crcToken}` });
    }
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
    messageId: string,
    posted: AdapterPostableMessage,
  ): Promise<RawMessage> {
    if (this.editError) throw this.editError;
    this.edited.push({ message: posted, messageId, threadId });
    return {
      id: "edited",
      raw: posted,
      threadId,
    };
  }

  async addReaction(): Promise<void> {}
  async deleteMessage(): Promise<void> {}
  async removeReaction(): Promise<void> {}
  async startTyping(_threadId: string, status?: string): Promise<void> {
    this.typingStatuses.push(status);
    if (this.startTypingError) throw this.startTypingError;
  }
}

function message(text: string, from: Message["author"] = author()): Message {
  return new Message({
    attachments: [],
    author: from,
    formatted: parseMarkdown(text),
    id: "message-1",
    isMention: true,
    metadata: metadata(),
    raw: { text },
    text,
    threadId: THREAD_ID,
  });
}

function serializedThread(overrides: { readonly isDM?: boolean } = {}) {
  return {
    _type: "chat:Thread",
    adapterName: "test",
    channelId: CHANNEL_ID,
    channelVisibility: "workspace",
    id: THREAD_ID,
    isDM: overrides.isDM ?? false,
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
