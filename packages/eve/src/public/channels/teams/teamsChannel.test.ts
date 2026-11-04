import { describe, expect, it, vi } from "vitest";
import type { SessionEvent } from "#protocol/session-event.js";

import { buildAdapterContext } from "#channel/adapter-context.js";
import { isCompiledChannel, type CompiledChannel } from "#channel/compiled-channel.js";
import { INACTIVE_REQUEST_NOTICE } from "#channel/inactive-prompt.js";
import { isHttpRouteDefinition } from "#channel/routes.js";
import { SessionNotActiveError } from "#channel/session-not-active-error.js";
import {
  mockChannelContext,
  type ObservedChannelDelivery,
} from "#internal/testing/mocks/mock-channel-operations.js";
import { teamsChannel, type TeamsChannelState } from "#public/channels/teams/index.js";
import { mockAgentRouteArgs } from "#internal/testing/mocks/mock-route-args.js";
import * as verification from "#public/channels/teams/verify.js";

function adapter(channel: unknown) {
  return asCompiled<TeamsChannelState>(channel).adapter;
}

function stubAccessor() {
  return { get: () => undefined, set: () => {} } as any;
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
      ...mockAgentRouteArgs(),
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
  it.each([
    ["matching", 200, 1],
    ["different", 401, 0],
    ["malformed JSON", 200, 0],
  ] as const)(
    "handles a %s verified activity before dispatch",
    async (kind, status, dispatched) => {
      const activity = messageActivity({ conversationType: "personal" });
      const verifier = vi.spyOn(verification, "verifyTeamsRequest").mockResolvedValue({
        body: kind === "malformed JSON" ? "{" : JSON.stringify(activity),
        serviceUrl:
          kind === "different" ? "https://smba.example.test/other" : String(activity.serviceUrl),
      });
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { response, send } = await firePost(teamsChannel(), activity);
        expect(response.status).toBe(status);
        expect(send).toHaveBeenCalledTimes(dispatched);
      } finally {
        verifier.mockRestore();
        warning.mockRestore();
      }
    },
  );

  it("mounts the default Teams activity route", () => {
    const channel = asCompiled(teamsChannel({ credentials: { webhookVerifier: () => true } }));
    expect(channel.routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      "POST /eve/v1/teams",
    ]);
  });

  it.each([
    ["personal", "private"],
    ["groupChat", "private"],
    ["channel", "unknown"],
  ] as const)("maps %s conversations to the %s audience", (conversationType, audience) => {
    const teamsAdapter = adapter(teamsChannel());
    if (!teamsAdapter.state) throw new Error("Expected Teams state.");
    teamsAdapter.state.conversationType = conversationType;

    expect(
      teamsAdapter.instrumentation?.audience?.({
        caller: { type: "anonymous" },
        channel: { kind: "channel:teams" },
        environment: "production",
        state: teamsAdapter.state,
      }),
    ).toBe(audience);
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

  it("marks an accepted personal message without a mention as not mentioned", async () => {
    const channel = teamsChannel({
      credentials: { webhookVerifier: () => true },
      onMessage: () => ({ auth: null }),
    });
    const raw = messageActivity({ conversationType: "personal" });
    raw.entities = [];
    raw.text = "Could you investigate?";

    const { send } = await firePost(channel, raw);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![1].context[0]).toContain("bot_id: BOT");
    expect(send.mock.calls[0]![1].context[0]).toContain("is_mentioned: false");
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
        answers: [{ optionId: "approve", interactionId: "REQ" }],
        state: {
          approvalResponderAccounts: {
            "teams:TENANT:USER": expect.objectContaining({ id: "USER", name: "Ada" }),
          },
        },
      }),
    );
  });

  it("answers an inactive press without waiting for its card to clear", async () => {
    let releaseUpdate!: () => void;
    const updateHeld = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    const updates: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PUT") {
        updates.push(String(url));
        await updateHeld;
      }
      return new Response(JSON.stringify({ id: "updated-card" }));
    });
    const channel = asCompiled<TeamsChannelState>(
      teamsChannel({
        api: { fetch: fetchMock },
        credentials: { tokenProvider: () => "test-token", webhookVerifier: () => true },
      }),
    );
    const post = channel.routes.find((route) => route.method === "POST");
    if (!post || !isHttpRouteDefinition(post)) throw new Error("Expected a POST route.");
    const send = vi.fn().mockRejectedValue(new SessionNotActiveError());
    const waitUntil = vi.fn();

    const response = await post.handler(
      new Request("https://eve.test/eve/v1/teams", {
        body: JSON.stringify({
          ...baseActivity({ conversationType: "channel" }),
          replyToId: "approval-card",
          name: "adaptiveCard/action",
          type: "invoke",
          value: {
            action: {
              data: {
                eve_input: {
                  kind: "tool-approval",
                  prompt: "Approve deployment?",
                  optionId: "approve",
                  replyToActivityId: "THREAD_ROOT",
                  requestId: "REQ",
                },
              },
            },
          },
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      {
        ...mockAgentRouteArgs(),
        from: mockChannelContext<TeamsChannelState>(send).from,
        resolveSession: vi.fn().mockResolvedValue(undefined) as never,
        attachSession: vi.fn() as any,
        params: {},
        to: vi.fn(),
        requestIp: null,
        waitUntil,
      },
    );

    expect(await response.json()).toMatchObject({ value: INACTIVE_REQUEST_NOTICE });
    expect(updates).toEqual([
      "https://smba.example.test/teams/v3/conversations/CONV/activities/approval-card",
    ]);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    releaseUpdate();
    await Promise.all(waitUntil.mock.calls.map(([task]) => task as Promise<unknown>));
  });

  it("retires a question card that predates prompts in its data when pressed inactive", async () => {
    const updates: { url: string; body: unknown }[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method === "PUT") updates.push({ body: await request.json(), url: request.url });
      return new Response(JSON.stringify({ id: "updated-card" }));
    });
    const channel = asCompiled<TeamsChannelState>(
      teamsChannel({
        api: { fetch: fetchMock },
        credentials: { tokenProvider: () => "test-token", webhookVerifier: () => true },
      }),
    );
    const post = channel.routes.find((route) => route.method === "POST");
    if (!post || !isHttpRouteDefinition(post)) throw new Error("Expected a POST route.");
    const send = vi.fn().mockRejectedValue(new SessionNotActiveError());
    const waitUntil = vi.fn();

    // A question card rendered before this change carries only the request and option.
    await post.handler(
      new Request("https://eve.test/eve/v1/teams", {
        body: JSON.stringify({
          ...baseActivity({ conversationType: "channel" }),
          replyToId: "question-card",
          type: "message",
          value: {
            eve_input: {
              optionId: "saturday",
              replyToActivityId: "THREAD_ROOT",
              requestId: "REQ",
            },
          },
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      {
        ...mockAgentRouteArgs(),
        from: mockChannelContext<TeamsChannelState>(send).from,
        resolveSession: vi.fn().mockResolvedValue(undefined) as never,
        attachSession: vi.fn() as any,
        params: {},
        to: vi.fn(),
        requestIp: null,
        waitUntil,
      },
    );
    await Promise.all(waitUntil.mock.calls.map(([task]) => task as Promise<unknown>));

    expect(updates.map(({ url }) => url)).toEqual([
      "https://smba.example.test/teams/v3/conversations/CONV/activities/question-card",
    ]);
    const [update] = updates;
    const card = (update!.body as { attachments: { content: Record<string, unknown> }[] })
      .attachments[0]?.content;
    expect(card?.actions).toBeUndefined();
    expect(card?.body).toEqual([
      { inlines: [{ text: "No longer active", type: "TextRun" }], type: "RichTextBlock" },
    ]);
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
      onAnswers: () => ({ auth: null }),
      onMessage,
    });

    const { send } = await firePost(channel, raw);

    expect(onMessage).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      "TENANT:CONV:THREAD_ROOT",
      expect.objectContaining({
        answers: [{ optionId: "cancel", interactionId: "REQ" }],
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

  it("keeps approval bookkeeping when a sent message carries its channel state", async () => {
    const channel = teamsChannel({ credentials: { tokenProvider: () => "token" } });
    const send = vi.fn(async () => ({ id: "SESSION" }));
    await channel.receive!(
      {
        target: {
          conversationId: "CONV",
          conversationType: "channel",
          replyToActivityId: "THREAD_ROOT",
          serviceUrl: "https://service.example/teams",
          tenantId: "TENANT",
        },
        auth: null,
        message: "Begin",
      },
      mockChannelContext<TeamsChannelState>(send as never),
    );
    const delivery = (
      send.mock.calls[0] as unknown[]
    )[1] as ObservedChannelDelivery<TeamsChannelState>;
    const teamsAdapter = adapter(channel);
    const ctx = buildAdapterContext(teamsAdapter, stubAccessor());
    const card = { activityId: "approval-card", prompt: "Approve deployment?" };
    const responder = { id: "USER", name: "Ada" };
    ctx.state.pendingPromptCards = { approval_1: card };
    ctx.state.approvalResponderAccounts = { "teams:TENANT:USER": responder };

    await teamsAdapter.deliver!({ message: "Begin", state: delivery.state }, ctx);

    expect(ctx.state.pendingPromptCards).toEqual({ approval_1: card });
    expect(ctx.state.approvalResponderAccounts).toEqual({ "teams:TENANT:USER": responder });
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

describe("teamsChannel sign-in button", () => {
  const SIGN_IN_URL = "https://connect.example.test/a/attempt-1";
  const required = (
    data: { readonly principalId?: string } = { principalId: "teams:TENANT:USER" },
  ): SessionEvent => ({
    type: "interaction.opened",
    data: {
      interactionId: "attempt-1",
      request: {
        kind: "sign-in",
        prompt: "Sign in to linear",
        signIn: { name: "linear", url: SIGN_IN_URL, userCode: "CODE-42" },
      },
      subject: { turnId: "turn-1" },
      audience: data.principalId === undefined ? undefined : { principalIds: [data.principalId] },
    },
  });
  const completed: SessionEvent = {
    type: "interaction.settled",
    data: { interactionId: "attempt-1", outcome: "declined" },
  };

  function sessionWith(events: readonly SessionEvent[]) {
    return {
      async *stream() {
        for (const [line, event] of events.entries())
          yield { ...event, meta: { position: { line, index: 0 }, endOfLine: true } };
      },
      getStreamTailIndex: async () => events.length - 1,
    };
  }

  function press(from: Record<string, unknown> = { id: "USER", name: "Ada" }) {
    return {
      ...baseActivity({ conversationType: "channel" }),
      from,
      name: "adaptiveCard/action",
      type: "invoke",
      value: {
        action: {
          data: {
            eve_authorization: {
              interactionId: "attempt-1",
              name: "linear",
              replyToActivityId: "THREAD_ROOT",
            },
          },
          type: "Action.Execute",
          verb: "eve.authorization.reveal",
        },
      },
    };
  }

  it("answers the person signing in with a card only they see, carrying the link and code", async () => {
    const resolveSession = vi.fn(async () => sessionWith([required()]));
    const channel = teamsChannel({ credentials: { webhookVerifier: () => true } });

    const { response } = await firePost(channel, press(), { resolveSession });

    const body = await response.json();
    expect(resolveSession).toHaveBeenCalledWith("TENANT:CONV:THREAD_ROOT");
    expect(body).toMatchObject({ type: "application/vnd.microsoft.card.adaptive" });
    expect(JSON.stringify(body)).toContain(SIGN_IN_URL);
    expect(JSON.stringify(body)).toContain("CODE-42");
  });

  it.each([
    {
      case: "someone else presses it",
      config: {},
      events: [required()],
      from: { id: "USER-BOB", name: "Bob" },
      reply: "Only the person who needs to sign in can open this sign-in.",
    },
    {
      case: "the attempt has no principal",
      config: {},
      events: [required({ principalId: undefined })],
      from: undefined,
      reply: "Only the person who needs to sign in can open this sign-in.",
    },
    {
      case: "onAnswers rejects the press",
      config: { onAnswers: () => null },
      events: [required()],
      from: undefined,
      reply: "Only the person who needs to sign in can open this sign-in.",
    },
    {
      case: "onAnswers throws",
      config: {
        onAnswers: () => {
          throw new Error("directory lookup failed");
        },
      },
      events: [required()],
      from: undefined,
      reply: "Only the person who needs to sign in can open this sign-in.",
    },
    {
      case: "the attempt already completed",
      config: {},
      events: [required(), completed],
      from: undefined,
      reply: "This sign-in is no longer active.",
    },
    {
      case: "the thread has no session",
      config: {},
      events: undefined,
      from: undefined,
      reply: "This sign-in is no longer active.",
    },
  ])("withholds the sign-in when $case", async ({ config, events, from, reply }) => {
    const channel = teamsChannel({ credentials: { webhookVerifier: () => true }, ...config });

    const { response } = await firePost(channel, press(from), {
      resolveSession: async () => (events === undefined ? undefined : sessionWith(events)),
    });

    const body = await response.json();
    expect(body).toEqual({
      statusCode: 200,
      type: "application/vnd.microsoft.activity.message",
      value: reply,
    });
    expect(JSON.stringify(body)).not.toContain(SIGN_IN_URL);
  });
});

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
