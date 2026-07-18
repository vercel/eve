import { describe, expect, it, vi } from "vitest";

import { isCompiledChannel, type CompiledChannel } from "#channel/compiled-channel.js";
import { isHttpRouteDefinition } from "#channel/routes.js";
import { teamsChannel, type TeamsChannelState } from "#public/channels/teams/index.js";

function asCompiled<T = unknown>(channel: unknown): CompiledChannel<T> {
  if (!isCompiledChannel(channel)) {
    throw new Error("Expected compiled channel.");
  }
  return channel as CompiledChannel<T>;
}

async function firePost(
  channel: unknown,
  body: Record<string, unknown>,
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
    id: "SESSION",
  }));
  const waitUntil = vi.fn();
  const response = await post.handler(
    new Request("https://eve.test/eve/v1/teams", {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
    {
      getSession: vi.fn(),
      cancel: vi.fn(),
      params: {},
      receive: vi.fn(),
      requestIp: null,
      send,
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
        };
      },
    });

    const { response, send } = await firePost(
      channel,
      messageActivity({ conversationType: "personal" }),
    );

    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![1]).toMatchObject({
      continuationToken: "TENANT:CONV:",
      state: {
        conversationId: "CONV",
        replyToActivityId: null,
        serviceUrl: "https://smba.example.test/teams",
      },
    });
    expect(send.mock.calls[0]![0].context[0]).toContain("<teams_context>");
  });

  it("default dispatch ignores unmentioned group messages", async () => {
    const channel = teamsChannel({ credentials: { webhookVerifier: () => true } });
    const raw = messageActivity({ conversationType: "groupChat" });
    raw.entities = [];

    const { send } = await firePost(channel, raw);
    expect(send).not.toHaveBeenCalled();
  });

  it("resumes invoke HITL responses with the clicker's auth and recorded thread", async () => {
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
              requestId: "REQ",
              optionId: "approve",
            },
          },
        },
      },
    });

    expect(await response.json()).toMatchObject({ statusCode: 200 });
    expect(send).toHaveBeenCalledWith(
      { inputResponses: [{ optionId: "approve", requestId: "REQ" }] },
      expect.objectContaining({
        auth: expect.objectContaining({ subject: "AAD_USER" }),
        continuationToken: "TENANT:CONV:THREAD_ROOT",
      }),
    );
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
        optionId: "deny",
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
      { inputResponses: [{ optionId: "deny", requestId: "REQ" }] },
      expect.objectContaining({ continuationToken: "TENANT:CONV:THREAD_ROOT" }),
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

    expect(send.mock.calls[0]![1]).toMatchObject({
      continuationToken: "TENANT:CONV:THREAD_ROOT",
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
    const initialOptions = initialRequest.send.mock.calls[0]![1] as {
      readonly continuationToken: string;
    };

    expect(followUpRequest.send.mock.calls[0]![1]).toMatchObject({
      continuationToken: initialOptions.continuationToken,
      state: { replyToActivityId: "THREAD_ROOT" },
    });
    expect(initialOptions.continuationToken).toBe("TENANT:CONV:THREAD_ROOT");
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
      { send },
    );

    expect(requests[0]!.url).toBe("https://service.example/teams/v3/conversations/CONV/activities");
    expect(send.mock.calls[0]![1]).toMatchObject({
      continuationToken: "TENANT:CONV:ANCHOR",
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
