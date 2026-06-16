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

  it("handles Adaptive Card invoke HITL responses", async () => {
    const channel = teamsChannel({ credentials: { webhookVerifier: () => true } });
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

    expect(await response.json()).toMatchObject({ statusCode: 200 });
    expect(send).toHaveBeenCalledWith(
      { inputResponses: [{ optionId: "approve", requestId: "REQ" }] },
      expect.objectContaining({
        auth: null,
        continuationToken: "TENANT:CONV:ACTIVITY_1",
      }),
    );
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
