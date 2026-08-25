import { describe, expect, it, vi } from "vitest";

import { callAdapterEventHandler } from "#channel/adapter.js";
import { buildAdapterContext } from "#channel/adapter-context.js";
import { isCompiledChannel, type CompiledChannel } from "#channel/compiled-channel.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import { isHttpRouteDefinition } from "#channel/routes.js";
import {
  mockChannelContext,
  type ObservedChannelDelivery,
} from "#internal/testing/mocks/mock-channel-operations.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { teamsChannel, type TeamsChannelState } from "#public/channels/teams/index.js";

function adapter(channel: unknown) {
  return asCompiled<TeamsChannelState>(channel).adapter;
}

function makeEvent<T extends UnstampedMessageStreamEvent["type"]>(
  type: T,
  data: unknown,
): UnstampedMessageStreamEvent {
  return { type, data } as UnstampedMessageStreamEvent;
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
  teamsAdapter: ReturnType<typeof adapter>,
  event: UnstampedMessageStreamEvent,
  ctx: ReturnType<typeof buildAdapterContext>,
) {
  return contextStorage.run(stubAlsContext, () =>
    callAdapterEventHandler(teamsAdapter, event, ctx),
  );
}

function asCompiled<T = unknown>(channel: unknown): CompiledChannel<T> {
  if (!isCompiledChannel(channel)) {
    throw new Error("Expected compiled channel.");
  }
  return channel as CompiledChannel<T>;
}

async function firePost(
  channel: unknown,
  body: Record<string, unknown>,
  overrides: {
    readonly resolveSession?: (continuationToken: string) => Promise<unknown>;
  } = {},
): Promise<{
  readonly response: Response;
  readonly send: ReturnType<typeof vi.fn>;
  readonly waitUntil: ReturnType<typeof vi.fn>;
}> {
  const compiled = asCompiled<TeamsChannelState>(channel);
  const post = compiled.routes.find((route) => route.method === "POST");
  if (!post || !isHttpRouteDefinition(post)) {
    throw new Error("Expected teams channel to define a POST route.");
  }

  const send = vi.fn(async (_input: unknown, _options: unknown) => ({
    continuationToken: "TOKEN",
    cancel: async () => ({ status: "no_active_turn" as const }),
    getEventStream: async () => new ReadableStream(),
    getStreamTailIndex: async () => -1,
    id: "SESSION",
  }));
  const waitUntil = vi.fn();
  const baseFrom = mockChannelContext<TeamsChannelState>(send).from;
  const response = await post.handler(
    new Request("https://eve.test/eve/v1/teams", {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
    {
      from(continuationToken) {
        return baseFrom(continuationToken);
      },
      resolveSession: (continuationToken) =>
        (overrides.resolveSession ?? vi.fn().mockResolvedValue(undefined))(
          continuationToken,
        ) as never,
      attachSession: vi.fn() as any,
      params: {},
      to: vi.fn(),
      requestIp: null,
      waitUntil,
    },
  );

  let drained = 0;
  while (drained < waitUntil.mock.calls.length) {
    const pending = waitUntil.mock.calls.slice(drained).map(([task]) => task as Promise<unknown>);
    drained = waitUntil.mock.calls.length;
    await Promise.all(pending);
  }

  return { response, send, waitUntil };
}

describe("teamsChannel", () => {
  it("mounts the default Teams activity route", () => {
    const channel = asCompiled(teamsChannel({ credentials: { webhookVerifier: () => true } }));
    expect(channel.routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      "POST /eve/v1/teams",
    ]);
    expect(channel.adapter.kind).toBe("teams");
  });

  it.each([
    ["personal", "private"],
    ["groupChat", "private"],
    ["channel", "unknown"],
  ] as const)("maps %s conversations to the %s audience", (conversationType, audience) => {
    const teamsAdapter = adapter(teamsChannel());
    if (!teamsAdapter.state) throw new Error("Expected Teams state.");
    teamsAdapter.state.conversationType = conversationType;

    expect(teamsAdapter.instrumentation?.metadata?.(teamsAdapter.state)).toMatchObject({
      audience,
    });
  });

  it("dispatches verified personal messages with Teams state", async () => {
    const channel = teamsChannel({
      credentials: { webhookVerifier: () => true },
      onMessage() {
        return {
          auth: {
            attributes: {},
            authenticator: "test",
            principalId: "USER",
            principalType: "user",
          },
          title: "Teams run",
        };
      },
    });

    const { response, send } = await firePost(
      channel,
      messageActivity({ conversationType: "personal" }),
    );

    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe("TENANT:CONV:");
    expect(send.mock.calls[0]![1]).toMatchObject({
      state: {
        conversationId: "CONV",
        replyToActivityId: null,
        serviceUrl: "https://smba.example.test/teams",
      },
      title: "Teams run",
    });
    expect(send.mock.calls[0]![1].context[0]).toContain("<teams_context>");
    expect(send.mock.calls[0]![1].context[0]).toContain("bot_id: BOT");
    expect(send.mock.calls[0]![1].context[0]).toContain("is_mentioned: true");
  });

  it("default dispatch ignores unmentioned group messages", async () => {
    const channel = teamsChannel({ credentials: { webhookVerifier: () => true } });
    const raw = messageActivity({ conversationType: "groupChat" });
    raw.entities = [];

    const { send } = await firePost(channel, raw);
    expect(send).not.toHaveBeenCalled();
  });

  it("default dispatch ignores bot-authored personal messages", async () => {
    const channel = teamsChannel({ credentials: { webhookVerifier: () => true } });
    const raw = messageActivity({ conversationType: "personal" });
    raw.from = { id: "OTHER_BOT", name: "Other bot", role: "bot" };

    const { send } = await firePost(channel, raw);

    expect(send).not.toHaveBeenCalled();
  });

  it("exposes the subscription helper to onMessage", async () => {
    const observed: boolean[] = [];
    const resolveSession = vi.fn().mockResolvedValue({ id: "SESSION" });
    const channel = teamsChannel({
      credentials: { webhookVerifier: () => true },
      async onMessage(ctx) {
        observed.push(await ctx.isSubscribed());
        return null;
      },
    });
    const raw = messageActivity({ conversationType: "channel" });
    raw.entities = [];
    raw.conversation = { conversationType: "channel", id: "CONV;messageid=THREAD_ROOT" };

    await firePost(channel, raw, { resolveSession });

    expect(observed).toEqual([true]);
    expect(resolveSession).toHaveBeenCalledWith("TENANT:CONV:THREAD_ROOT");
  });

  it("allows a mention-or-subscription onMessage policy", async () => {
    const channel = teamsChannel({
      credentials: { webhookVerifier: () => true },
      async onMessage(ctx, message) {
        return message.isBotMentioned || (await ctx.isSubscribed()) ? { auth: null } : null;
      },
    });
    const raw = messageActivity({ conversationType: "channel" });
    raw.entities = [];
    raw.conversation = { conversationType: "channel", id: "CONV;messageid=THREAD_ROOT" };

    const { send } = await firePost(channel, raw, {
      resolveSession: vi.fn().mockResolvedValue({ id: "SESSION" }),
    });

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("passes bot-authored messages to onMessage", async () => {
    const onMessage = vi.fn((_ctx: unknown, _message: unknown) => null);
    const channel = teamsChannel({
      credentials: { webhookVerifier: () => true },
      onMessage,
    });
    const raw = messageActivity({ conversationType: "channel" });
    raw.entities = [];
    raw.from = { id: "OTHER_BOT", name: "Other bot", role: "bot" };

    const { send } = await firePost(channel, raw);

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ from: expect.objectContaining({ id: "OTHER_BOT", role: "bot" }) }),
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("resumes tool approvals with the clicker's auth and durable Teams identity", async () => {
    const channel = teamsChannel({ credentials: { webhookVerifier: () => true } });
    const { response, send } = await firePost(channel, {
      ...baseActivity({ conversationType: "channel" }),
      from: { aadObjectId: "AAD_USER", id: "USER", name: "Ada" },
      name: "adaptiveCard/action",
      type: "invoke",
      value: {
        action: {
          data: {
            eve_input: {
              replyToActivityId: "THREAD_ROOT",
              kind: "tool-approval",
              requestId: "REQ",
              optionId: "approve",
            },
          },
        },
      },
    });

    expect(await response.json()).toMatchObject({ statusCode: 200 });
    expect(send).toHaveBeenCalledWith(
      "TENANT:CONV:THREAD_ROOT",
      expect.objectContaining({
        auth: expect.objectContaining({ subject: "AAD_USER" }),
        inputResponses: [{ optionId: "approve", requestId: "REQ" }],
        state: {
          approvalResponderAccounts: {
            "teams:TENANT:USER": expect.objectContaining({ id: "USER", name: "Ada" }),
          },
        },
      }),
    );
  });

  it("updates a posted approval card after a durable cancel settlement", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValue(new Response(JSON.stringify({ id: "updated-card" })));
    const channel = teamsChannel({
      api: { fetch: fetchMock },
      credentials: { tokenProvider: () => "test-token", webhookVerifier: () => true },
    });
    const teamsAdapter = adapter(channel);
    const ctx = buildAdapterContext(teamsAdapter, stubAccessor());

    ctx.state.bot = { id: "BOT" };
    ctx.state.conversationId = "19:conversation@thread.tacv2;messageid=THREAD_ROOT";
    ctx.state.conversationType = "channel";
    ctx.state.replyToActivityId = "THREAD_ROOT";
    ctx.state.serviceUrl = "https://smba.example.test/teams";
    ctx.state.tenantId = "TENANT";

    await callEvent(
      teamsAdapter,
      makeEvent("input.requested", {
        requests: [
          {
            action: { callId: "call-1", input: {}, kind: "tool-call", toolName: "deploy" },
            kind: "tool-approval",
            options: [
              { id: "approve", label: "Approve" },
              { id: "cancel", label: "Cancel" },
            ],
            prompt: "Approve deployment?",
            requestId: "approval_1",
          },
        ],
        sequence: 1,
        stepIndex: 0,
        turnId: "turn-1",
      }),
      ctx,
    );

    expect(ctx.state.pendingApprovalCards).toEqual({});

    const { send } = await firePost(channel, {
      ...baseActivity({ conversationType: "channel" }),
      conversation: {
        conversationType: "channel",
        id: "19:conversation@thread.tacv2;messageid=THREAD_ROOT",
      },
      from: { id: "USER", name: "Ada" },
      replyToId: "approval-card",
      name: "adaptiveCard/action",
      type: "invoke",
      value: {
        action: {
          data: {
            eve_input: {
              kind: "tool-approval",
              prompt: "Approve deployment?",
              optionId: "cancel",
              replyToActivityId: "THREAD_ROOT",
              requestId: "approval_1",
            },
          },
        },
      },
    });
    const delivery = send.mock.calls[0]?.[1] as Extract<
      ObservedChannelDelivery<TeamsChannelState>,
      { readonly inputResponses: readonly unknown[] }
    >;
    await teamsAdapter.deliver!(
      { inputResponses: delivery.inputResponses, state: delivery.state },
      ctx,
    );
    expect(ctx.state.pendingApprovalCards).toEqual({
      approval_1: { activityId: "approval-card", prompt: "Approve deployment?" },
    });

    await callEvent(
      teamsAdapter,
      makeEvent("approval.settled", {
        outcome: "cancelled",
        requestId: "approval_1",
        responderPrincipalId: "teams:TENANT:USER",
        sequence: 1,
        stepIndex: 1,
        turnId: "turn-1",
      }),
      ctx,
    );

    const updateCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith(
          "/v3/conversations/19%3Aconversation%40thread.tacv2/activities/approval-card",
        ) && (init as RequestInit).method === "PUT",
    );
    expect(updateCall).toBeDefined();
    const updateBody = JSON.parse(String((updateCall?.[1] as RequestInit).body)) as {
      channelData?: unknown;
      conversation?: unknown;
      from?: unknown;
      recipient?: unknown;
      replyToId?: string;
      text?: string;
      type?: string;
    };
    expect(updateBody).toMatchObject({ type: "message" });
    expect(updateBody.channelData).toBeUndefined();
    expect(updateBody.conversation).toBeUndefined();
    expect(updateBody.from).toBeUndefined();
    expect(updateBody.recipient).toBeUndefined();
    expect(updateBody.replyToId).toBeUndefined();
    expect(updateBody.text).toBeUndefined();
  });

  it("handles unmentioned message-form HITL responses before the mention gate", async () => {
    const onMessage = vi.fn(() => null);
    const raw = messageActivity({ conversationType: "channel" });
    raw.entities = [];
    raw.text = "";
    raw.value = {
      eve_input: {
        replyToActivityId: "THREAD_ROOT",
        requestId: "REQ",
        optionId: "cancel",
      },
    };
    const channel = teamsChannel({
      credentials: { webhookVerifier: () => true },
      onInputResponse: () => ({ auth: null }),
      onMessage,
    });

    const { send } = await firePost(channel, raw);

    expect(onMessage).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      "TENANT:CONV:THREAD_ROOT",
      expect.objectContaining({
        inputResponses: [{ optionId: "cancel", requestId: "REQ" }],
      }),
    );
  });

  it("rejects HITL responses when a custom message gate has no input gate", async () => {
    const channel = teamsChannel({
      credentials: { webhookVerifier: () => true },
      onMessage: () => ({ auth: null }),
    });
    const { send } = await firePost(channel, {
      ...baseActivity({ conversationType: "channel" }),
      name: "adaptiveCard/action",
      type: "invoke",
      value: {
        action: {
          data: {
            eve_input: {
              replyToActivityId: "THREAD_ROOT",
              requestId: "REQ",
              optionId: "approve",
            },
          },
        },
      },
    });

    expect(send).not.toHaveBeenCalled();
  });

  it("normalizes suffixed channel conversation ids", async () => {
    const channel = teamsChannel({
      credentials: { webhookVerifier: () => true },
      onMessage: () => ({ auth: null }),
    });
    const raw = messageActivity({ conversationType: "channel" });
    raw.conversation = { conversationType: "channel", id: "CONV;messageid=THREAD_ROOT" };
    raw.replyToId = "VOLATILE_ACTIVITY";

    const { send } = await firePost(channel, raw);

    expect(send.mock.calls[0]![0]).toBe("TENANT:CONV:THREAD_ROOT");
    expect(send.mock.calls[0]![1]).toMatchObject({
      state: { replyToActivityId: "THREAD_ROOT" },
    });
  });

  it("keeps a channel thread token stable when follow-ups omit replyToId", async () => {
    const channel = teamsChannel({
      credentials: { webhookVerifier: () => true },
      onMessage: () => ({ auth: null }),
    });
    const initial = messageActivity({ conversationType: "channel" });
    initial.conversation = { conversationType: "channel", id: "CONV;messageid=THREAD_ROOT" };
    initial.id = "THREAD_ROOT";
    const followUp = messageActivity({ conversationType: "channel" });
    followUp.conversation = { conversationType: "channel", id: "CONV;messageid=THREAD_ROOT" };
    followUp.id = "FOLLOW_UP_ACTIVITY";

    const initialRequest = await firePost(channel, initial);
    const followUpRequest = await firePost(channel, followUp);
    const initialToken = initialRequest.send.mock.calls[0]![0] as string;

    expect(followUpRequest.send.mock.calls[0]![0]).toBe(initialToken);
    expect(followUpRequest.send.mock.calls[0]![1]).toMatchObject({
      state: { replyToActivityId: "THREAD_ROOT" },
    });
    expect(initialToken).toBe("TENANT:CONV:THREAD_ROOT");
  });

  it("receive starts proactive sessions and anchors initial channel messages", async () => {
    const requests: Array<{ body: unknown; url: string }> = [];
    const channel = teamsChannel({
      api: {
        fetch: vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
          requests.push({
            body: init?.body ? JSON.parse(String(init.body)) : null,
            url: String(url),
          });
          return Response.json({ id: "ANCHOR" });
        }),
      },
      credentials: { tokenProvider: () => "token" },
    });
    const send = vi.fn(async (_input: unknown, _options: unknown) => ({
      continuationToken: "TOKEN",
      cancel: async () => ({ status: "no_active_turn" as const }),
      getEventStream: async () => new ReadableStream(),
      getStreamTailIndex: async () => -1,
      id: "SESSION",
    }));

    await channel.receive!(
      {
        target: {
          conversationId: "CONV",
          conversationType: "channel",
          initialMessage: "Investigation",
          serviceUrl: "https://service.example/teams",
          tenantId: "TENANT",
        },
        auth: null,
        message: "Begin",
      },
      mockChannelContext(send),
    );

    expect(requests[0]!.url).toBe("https://service.example/teams/v3/conversations/CONV/activities");
    expect(send.mock.calls[0]![0]).toBe("TENANT:CONV:ANCHOR");
    expect(send.mock.calls[0]![1]).toMatchObject({
      state: { replyToActivityId: "ANCHOR" },
    });
  });
});

function messageActivity(input: { readonly conversationType: string }): Record<string, unknown> {
  return {
    ...baseActivity(input),
    entities: [
      {
        mentioned: { id: "BOT", name: "eve Bot" },
        text: "<at>eve Bot</at>",
        type: "mention",
      },
    ],
    text: input.conversationType === "personal" ? "hello" : "<at>eve Bot</at> hello",
    textFormat: "xml",
    type: "message",
  };
}

function baseActivity(input: { readonly conversationType: string }): Record<string, unknown> {
  return {
    channelData: {
      channel: { id: "CHANNEL" },
      team: { id: "TEAM" },
      tenant: { id: "TENANT" },
    },
    conversation: { conversationType: input.conversationType, id: "CONV" },
    from: { id: "USER", name: "Ada" },
    id: "ACTIVITY_1",
    recipient: { id: "BOT", name: "eve Bot" },
    serviceUrl: "https://smba.example.test/teams",
  };
}
