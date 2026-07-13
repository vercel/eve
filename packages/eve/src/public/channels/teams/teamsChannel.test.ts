import { describe, expect, it, vi } from "vitest";

import { isCompiledChannel, type CompiledChannel } from "#channel/compiled-channel.js";
import { isHttpRouteDefinition } from "#channel/routes.js";
import {
  renderInputRequestMessage,
  teamsChannel,
  type TeamsChannelState,
} from "#public/channels/teams/index.js";

const HITL_SECRET = "test-secret";

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
      authorizeActivity() {
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

  it("handles Adaptive Card invoke HITL responses with approver auth", async () => {
    const channel = teamsChannel({ credentials: testCredentials() });
    const { response, send } = await firePost(channel, {
      ...baseActivity({ conversationType: "channel" }),
      from: { aadObjectId: "AAD_USER", id: "USER", name: "Ada" },
      name: "adaptiveCard/action",
      type: "invoke",
      value: {
        action: {
          data: {
            eve_input: {
              requestId: "REQ",
              optionId: "approve",
              route: hitlRoute(),
            },
          },
        },
      },
    });

    expect(await response.json()).toMatchObject({ statusCode: 200 });
    expect(send).toHaveBeenCalledWith(
      { inputResponses: [{ optionId: "approve", requestId: "REQ" }] },
      expect.objectContaining({
        auth: expect.objectContaining({
          attributes: expect.objectContaining({ aad_object_id: "AAD_USER" }),
          principalId: "teams:TENANT:USER",
          subject: "AAD_USER",
        }),
        continuationToken: "TENANT:CONV:THREAD_ROOT",
      }),
    );
  });

  it("does not let approval submissions bypass a legacy message allowlist", async () => {
    const channel = teamsChannel({
      credentials: testCredentials(),
      onMessage: () => null,
    });
    const { send } = await firePost(channel, {
      ...baseActivity({ conversationType: "channel" }),
      name: "adaptiveCard/action",
      type: "invoke",
      value: {
        action: {
          data: {
            eve_input: {
              requestId: "REQ",
              optionId: "approve",
              route: hitlRoute(),
            },
          },
        },
      },
    });

    expect(send).not.toHaveBeenCalled();
  });

  it("rejects tampered HITL continuation tokens", async () => {
    const channel = teamsChannel({ credentials: testCredentials() });
    const { send } = await firePost(channel, {
      ...baseActivity({ conversationType: "channel" }),
      name: "adaptiveCard/action",
      type: "invoke",
      value: {
        action: {
          data: {
            eve_input: {
              requestId: "REQ",
              optionId: "approve",
              route: {
                ...hitlRoute(),
                continuationToken: "TENANT:OTHER_CONVERSATION:THREAD_ROOT",
              },
            },
          },
        },
      },
    });

    expect(send).not.toHaveBeenCalled();
  });

  it("rejects unsigned legacy approval cards", async () => {
    const channel = teamsChannel({ credentials: testCredentials() });
    const { response, send } = await firePost(channel, {
      ...baseActivity({ conversationType: "channel" }),
      name: "adaptiveCard/action",
      type: "invoke",
      value: {
        action: {
          data: {
            eve_input: { requestId: "REQ", optionId: "approve" },
          },
        },
      },
    });

    expect(await response.json()).toMatchObject({ value: expect.stringMatching(/expired/i) });
    expect(send).not.toHaveBeenCalled();
  });

  it("forwards unrelated invokes that contain eve_input data", async () => {
    const onInvoke = vi.fn(() => ({ handled: true }));
    const channel = teamsChannel({
      credentials: { webhookVerifier: () => true },
      onInvoke,
    });
    const { response, send } = await firePost(channel, {
      ...baseActivity({ conversationType: "channel" }),
      name: "composeExtension/query",
      type: "invoke",
      value: {
        action: {
          data: {
            eve_input: { requestId: "REQ", optionId: "approve" },
          },
        },
      },
    });

    expect(await response.json()).toEqual({ handled: true });
    expect(onInvoke).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it("drops HITL responses rejected by the shared activity authorizer", async () => {
    const channel = teamsChannel({
      authorizeActivity: () => null,
      credentials: testCredentials(),
    });
    const { response, send } = await firePost(channel, {
      ...baseActivity({ conversationType: "channel" }),
      name: "adaptiveCard/action",
      type: "invoke",
      value: {
        action: {
          data: {
            eve_input: { requestId: "REQ", optionId: "approve", route: hitlRoute() },
          },
        },
      },
    });

    expect(await response.json()).toMatchObject({ statusCode: 200 });
    expect(send).not.toHaveBeenCalled();
  });

  it("handles unmentioned message-form HITL responses before the mention gate", async () => {
    const onMessage = vi.fn(() => null);
    const raw = messageActivity({ conversationType: "channel" });
    raw.entities = [];
    raw.text = "";
    raw.replyToId = "THREAD_ROOT";
    raw.value = {
      eve_input: {
        requestId: "REQ",
        optionId: "deny",
        route: hitlRoute(),
      },
    };
    const channel = teamsChannel({
      authorizeActivity: () => ({
        auth: {
          attributes: {},
          authenticator: "teams-approval",
          principalId: "USER",
          principalType: "user",
        },
      }),
      credentials: testCredentials(),
      onMessage,
    });

    const { send } = await firePost(channel, raw);

    expect(onMessage).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      { inputResponses: [{ optionId: "deny", requestId: "REQ" }] },
      expect.objectContaining({ continuationToken: "TENANT:CONV:THREAD_ROOT" }),
    );
  });

  it("normalizes channel continuation tokens across suffixed message conversations and invokes", async () => {
    const channel = teamsChannel({
      credentials: { webhookVerifier: () => true },
      authorizeActivity: () => ({
        auth: {
          attributes: {},
          authenticator: "test",
          principalId: "USER",
          principalType: "user",
        },
      }),
      onMessage: () => ({}),
    });
    const raw = messageActivity({ conversationType: "channel" });
    raw.conversation = {
      conversationType: "channel",
      id: "CONV;messageid=THREAD_ROOT",
    };
    raw.replyToId = "VOLATILE_ACTIVITY";

    const { send } = await firePost(channel, raw);

    expect(send.mock.calls[0]![1]).toMatchObject({
      continuationToken: "TENANT:CONV:THREAD_ROOT",
      state: {
        conversationId: "CONV;messageid=THREAD_ROOT",
        replyToActivityId: "THREAD_ROOT",
      },
    });
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

function testCredentials() {
  return { hitlSecret: HITL_SECRET, webhookVerifier: () => true };
}

function hitlRoute(): Record<string, unknown> {
  const body = renderInputRequestMessage(
    {
      action: { callId: "TC", input: {}, kind: "tool-call", toolName: "deploy" },
      display: "confirmation",
      options: [
        { id: "approve", label: "Approve" },
        { id: "deny", label: "Deny" },
      ],
      prompt: "Approve deploy?",
      requestId: "REQ",
    },
    {
      continuationToken: "TENANT:CONV:THREAD_ROOT",
      conversationId: "CONV",
      secret: HITL_SECRET,
      tenantId: "TENANT",
    },
  );
  const card = body.attachments?.[0]?.content as {
    actions?: Array<{ data?: Record<string, unknown> }>;
  };
  const payload = card.actions?.[0]?.data?.eve_input;
  if (!payload || typeof payload !== "object" || !("route" in payload)) {
    throw new Error("Expected rendered Teams HITL route.");
  }
  return payload.route as Record<string, unknown>;
}

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
