import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

import { afterEach, describe, expect, it, type Mock, vi } from "vitest";

import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler, type ChannelAdapter } from "#channel/adapter.js";
import { isCompiledChannel, type CompiledChannel } from "#channel/compiled-channel.js";
import { INACTIVE_REQUEST_NOTICE } from "#channel/inactive-prompt.js";
import { isHttpRouteDefinition } from "#channel/routes.js";
import { SessionNotActiveError } from "#channel/session-not-active-error.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import { mockChannelContext } from "#internal/testing/mocks/mock-channel-operations.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import {
  DISCORD_HITL_FREEFORM_TEXT_INPUT_ID,
  renderInputRequestComponents,
} from "#public/channels/discord/hitl.js";
import {
  defaultDiscordAuth,
  defaultDiscordMessageAuth,
  discordChannel,
  type DiscordGatewayConfig,
} from "#public/channels/discord/index.js";
import { captureLogRecords } from "#internal/testing/log-records.js";
import { installMockedVercelIssuer } from "#internal/testing/mock-vercel-oidc-issuer.js";
import { mockAgentRouteArgs } from "#internal/testing/mocks/mock-route-args.js";

function asCompiled<T = unknown>(channel: unknown): CompiledChannel<T> {
  if (!isCompiledChannel(channel)) {
    throw new Error("Expected a CompiledChannel.");
  }
  return channel as CompiledChannel<T>;
}

function getAdapter(channel: unknown): ChannelAdapter<any> {
  return asCompiled(channel).adapter;
}

function withState(
  adapter: ChannelAdapter<any>,
  state: Record<string, unknown>,
): ChannelAdapter<any> {
  return { ...adapter, state: { ...adapter.state, ...state } };
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

describe("discordChannel() audience classification", () => {
  it.each(["private", "unknown"] as const)("classifies the %s audience", (audience) => {
    const adapter = withState(getAdapter(discordChannel()), { audience });

    expect(
      adapter.instrumentation?.audience?.({
        auth: null,
        caller: { type: "anonymous" },
        channel: { kind: "channel:discord" },
        environment: "production",
        state: adapter.state,
      }),
    ).toBe(audience);
  });
});

function captureAccessor(initialContinuationToken: string): {
  accessor: any;
  writes: Array<[string, unknown]>;
} {
  const writes: Array<[string, unknown]> = [];
  let continuationToken = initialContinuationToken;
  return {
    accessor: {
      get: (key: { name: string }) =>
        key.name === "eve.continuationToken" ? continuationToken : undefined,
      set: (key: { name: string }, value: unknown | ((current: unknown) => unknown)) => {
        const next =
          typeof value === "function" ? (value as (current: unknown) => unknown)(undefined) : value;
        if (key.name === "eve.continuationToken") continuationToken = String(next);
        writes.push([key.name, next]);
        return next;
      },
    },
    writes,
  };
}

function makeEvent<T extends UnstampedMessageStreamEvent["type"]>(
  type: T,
  data: unknown,
): UnstampedMessageStreamEvent {
  return { type, data } as UnstampedMessageStreamEvent;
}

function testKeys(): { privateKey: KeyObject; publicKeyHex: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  return {
    privateKey,
    publicKeyHex: Buffer.from(der).subarray(-32).toString("hex"),
  };
}

function signedRequest(input: {
  readonly body: string;
  readonly privateKey: KeyObject;
  readonly signatureOverride?: string;
}): Request {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(null, Buffer.from(`${timestamp}${input.body}`), input.privateKey).toString(
    "hex",
  );
  return new Request("https://example.com/eve/v1/discord", {
    body: input.body,
    headers: {
      "content-type": "application/json",
      "x-signature-ed25519": input.signatureOverride ?? signature,
      "x-signature-timestamp": timestamp,
    },
    method: "POST",
  });
}

async function firePost(
  channel: unknown,
  request: Request,
  send: Mock<(...args: any[]) => any> = vi.fn().mockResolvedValue({ id: "s1" }),
): Promise<{
  response: Response;
  send: Mock<(...args: any[]) => any>;
  waitUntil: ReturnType<typeof vi.fn>;
}> {
  const compiled = asCompiled(channel);
  const post = compiled.routes.find((route) => route.method === "POST");
  if (!post || !isHttpRouteDefinition(post)) {
    throw new Error("Expected discord channel to define a POST route.");
  }
  const waitUntil = vi.fn();

  const response = await post.handler(request, {
    ...mockAgentRouteArgs(),
    attachSession: vi.fn() as any,
    ...mockChannelContext(send),
    to: vi.fn() as any,
    params: {},
    requestIp: null,
    waitUntil,
  });

  let drained = 0;
  while (drained < waitUntil.mock.calls.length) {
    const pending = waitUntil.mock.calls.slice(drained).map(([task]) => task as Promise<unknown>);
    drained = waitUntil.mock.calls.length;
    await Promise.allSettled(pending);
  }

  return { response, send, waitUntil };
}

function commandBody(overrides?: Record<string, unknown>): string {
  return JSON.stringify({
    application_id: "APP1",
    channel_id: "C01",
    data: {
      id: "CMD1",
      name: "ask",
      options: [{ name: "message", type: 3, value: "hello discord" }],
    },
    guild_id: "G01",
    id: "I01",
    token: "tok",
    type: 2,
    user: { id: "U01", username: "ada" },
    version: 1,
    ...overrides,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("discordChannel() inbound route", () => {
  it("mounts the default Discord interaction route", () => {
    expect(
      discordChannel().routes.map((route) => ({ method: route.method, path: route.path })),
    ).toEqual([{ method: "POST", path: "/eve/v1/discord" }]);
  });

  it("responds to Discord PING interactions", async () => {
    const { privateKey, publicKeyHex } = testKeys();
    const channel = discordChannel({ credentials: { publicKey: publicKeyHex } });

    const { response, send } = await firePost(
      channel,
      signedRequest({ body: JSON.stringify({ type: 1 }), privateKey }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ type: 1 });
    expect(send).not.toHaveBeenCalled();
  });

  it("dispatches verified application commands with Discord auth and state", async () => {
    const { privateKey, publicKeyHex } = testKeys();
    const channel = discordChannel({
      credentials: { publicKey: publicKeyHex },
      onCommand: (_ctx, interaction) => ({
        auth: defaultDiscordAuth(interaction),
        title: "Discord run",
      }),
    });

    const { response, send } = await firePost(
      channel,
      signedRequest({ body: commandBody(), privateKey }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ type: 5 });
    expect(send).toHaveBeenCalledTimes(1);
    const [continuationToken, input] = send.mock.calls[0]!;
    expect((input as { context: string[] }).context[0]).toContain("<discord_context>");
    expect((input as { context: string[] }).context[0]).toContain("application_id: APP1");
    expect(String((input as { message: string }).message)).toContain("hello discord");
    expect(continuationToken).toBe("C01:I01");
    expect(input).toMatchObject({
      auth: {
        authenticator: "discord-interaction",
        principalId: "discord:G01:U01",
      },
      state: {
        applicationId: "APP1",
        channelId: "C01",
        conversationId: "I01",
        guildId: "G01",
        hasMessageAnchor: false,
        initialResponseSent: false,
        interactionToken: "tok",
      },
      title: "Discord run",
    });
  });

  it("acknowledges commands without dispatch when onCommand returns null", async () => {
    const { privateKey, publicKeyHex } = testKeys();
    const channel = discordChannel({
      credentials: { publicKey: publicKeyHex },
      onCommand: () => null,
    });

    const { response, send } = await firePost(
      channel,
      signedRequest({ body: commandBody(), privateKey }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { content: "Command ignored.", flags: 64 },
      type: 4,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects requests with invalid signatures", async () => {
    const logs = captureLogRecords();
    const { privateKey, publicKeyHex } = testKeys();
    const channel = discordChannel({ credentials: { publicKey: publicKeyHex } });

    const { response, send } = await firePost(
      channel,
      signedRequest({
        body: commandBody(),
        privateKey,
        signatureOverride: "00".repeat(64),
      }),
    );

    expect(response.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
    expect(logs.records).toContainEqual(
      expect.objectContaining({ level: "warn", message: "discord inbound verification failed" }),
    );
  });

  describe("answering a HITL press", () => {
    const { privateKey, publicKeyHex } = testKeys();
    const customId = (
      renderInputRequestComponents({
        action: { callId: "call_1", input: {}, kind: "tool-call", toolName: "ask_question" },
        kind: "question",
        options: [{ id: "approve", label: "Approve" }],
        prompt: "Approve?",
        requestId: "call_1",
      })[0] as { components: Array<{ custom_id: string }> }
    ).components[0]!.custom_id;
    /** A press of Approve in guild G01, as Discord sends it: the presser on `member`. */
    const press = (userId: string, content: string | null = "Approve?") =>
      signedRequest({
        body: JSON.stringify({
          application_id: "APP1",
          channel_id: "C01",
          data: { component_type: 2, custom_id: customId },
          guild_id: "G01",
          id: `I-${userId}`,
          member: { user: { id: userId, username: userId } },
          message: { content, id: "M01" },
          token: "tok2",
          type: 3,
          version: 1,
        }),
        privateKey,
      });
    const answered = (principalId: string) =>
      expect.objectContaining({
        auth: expect.objectContaining({ principalId }),
        inputResponses: [{ optionId: "approve", requestId: "call_1" }],
      });

    it("answers as the guild member who pressed", async () => {
      const channel = discordChannel({ credentials: { publicKey: publicKeyHex } });

      const { response, send } = await firePost(channel, press("U01"));

      await expect(response.json()).resolves.toEqual({ type: 6 });
      expect(send).toHaveBeenCalledWith("C01:M01", answered("discord:G01:U01"));
    });

    it("lets onInputResponse accept a press with ctx.defaultAuth or drop it", async () => {
      const channel = discordChannel({
        credentials: { publicKey: publicKeyHex },
        onInputResponse: (ctx, interaction) =>
          interaction.user.id === "U01" ? { auth: ctx.defaultAuth } : null,
      });

      const accepted = await firePost(channel, press("U01"));
      const dropped = await firePost(channel, press("U02"));

      expect(accepted.send).toHaveBeenCalledWith("C01:M01", answered("discord:G01:U01"));
      expect(dropped.send).not.toHaveBeenCalled();
    });

    it.each([
      {
        name: "onInputResponse throws",
        config: {
          onInputResponse: () => {
            throw new Error("policy lookup failed");
          },
        },
        log: { level: "error", message: "input response handler failed" },
      },
      {
        name: "onCommand is custom and onInputResponse isn't",
        config: { onCommand: () => ({ auth: null }) },
        log: { level: "warn", message: expect.stringContaining("set onInputResponse") },
      },
    ])("drops a press when $name", async ({ config, log }) => {
      const logs = captureLogRecords();
      const channel = discordChannel({ credentials: { publicKey: publicKeyHex }, ...config });

      const { send } = await firePost(channel, press("U01"));

      expect(send).not.toHaveBeenCalled();
      expect(logs.records).toContainEqual(expect.objectContaining(log));
    });

    describe("when no session takes the press", () => {
      const notActive = () => vi.fn().mockRejectedValue(new SessionNotActiveError());
      const discordApi = (config: Parameters<typeof discordChannel>[0] = {}) => {
        const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
          Response.json({ channel_id: "C01", id: "M02" }),
        );
        return {
          channel: discordChannel({
            api: { fetch: fetchMock as typeof fetch },
            credentials: { applicationId: "APP1", botToken: "bot-token", publicKey: publicKeyHex },
            ...config,
          }),
          calls: () =>
            fetchMock.mock.calls.map(([url, init]) => ({
              body: JSON.parse(String(init?.body)) as unknown,
              method: init?.method,
              url: String(url),
            })),
        };
      };
      const prompt = {
        body: {
          allowed_mentions: { parse: [] },
          components: [],
          content: "Approve?\n\nNo longer active",
        },
        method: "PATCH",
        url: "https://discord.com/api/v10/channels/C01/messages/M01",
      };
      const notice = {
        body: { allowed_mentions: { parse: [] }, content: INACTIVE_REQUEST_NOTICE, flags: 64 },
        method: "POST",
        url: "https://discord.com/api/v10/webhooks/APP1/tok2",
      };

      it("retires the pressed prompt and tells only the presser", async () => {
        captureLogRecords();
        const { channel, calls } = discordApi();

        await firePost(channel, press("U01"), notActive());

        expect(calls()).toEqual([prompt, notice]);
      });

      it("only tells the presser when the press carries no prompt to keep", async () => {
        captureLogRecords();
        const { channel, calls } = discordApi();

        await firePost(channel, press("U01", null), notActive());

        expect(calls()).toEqual([notice]);
      });

      it("leaves the prompt alone when delivery fails for another reason", async () => {
        captureLogRecords();
        const { channel, calls } = discordApi();

        await firePost(channel, press("U01"), vi.fn().mockRejectedValue(new Error("boom")));

        expect(calls()).toEqual([]);
      });

      it("leaves the prompt alone when onInputResponse drops the press", async () => {
        captureLogRecords();
        const { channel, calls } = discordApi({ onInputResponse: () => null });

        await firePost(channel, press("U01"), notActive());

        expect(calls()).toEqual([]);
      });
    });
  });

  it("opens and resolves freeform HITL modals", async () => {
    const { privateKey, publicKeyHex } = testKeys();
    const components = renderInputRequestComponents({
      action: { callId: "call_1", input: {}, kind: "tool-call", toolName: "ask_question" },
      allowFreeform: true,
      kind: "question",
      prompt: "Explain",
      requestId: "call_1",
    });
    const customId = (components[0] as { components: Array<{ custom_id: string }> }).components[0]!
      .custom_id;
    const channel = discordChannel({ credentials: { publicKey: publicKeyHex } });

    const open = await firePost(
      channel,
      signedRequest({
        body: JSON.stringify({
          application_id: "APP1",
          channel_id: "C01",
          data: { component_type: 2, custom_id: customId },
          id: "I02",
          message: { content: "Explain", id: "M01" },
          token: "tok2",
          type: 3,
          user: { id: "U01", username: "ada" },
          version: 1,
        }),
        privateKey,
      }),
    );
    const modal = (await open.response.json()) as { data: { custom_id: string }; type: number };
    expect(modal.type).toBe(9);

    const submit = await firePost(
      channel,
      signedRequest({
        body: JSON.stringify({
          application_id: "APP1",
          channel_id: "C01",
          data: {
            components: [
              {
                components: [
                  { custom_id: DISCORD_HITL_FREEFORM_TEXT_INPUT_ID, value: "freeform answer" },
                ],
              },
            ],
            custom_id: modal.data.custom_id,
          },
          id: "I03",
          message: { id: "M01" },
          token: "tok3",
          type: 5,
          user: { id: "U01", username: "ada" },
          version: 1,
        }),
        privateKey,
      }),
    );

    await expect(submit.response.json()).resolves.toMatchObject({
      data: { content: "Answer received.", flags: 64 },
      type: 4,
    });
    expect(submit.send).toHaveBeenCalledWith(
      "C01:M01",
      expect.objectContaining({
        auth: expect.objectContaining({ principalId: "discord:U01" }),
        inputResponses: [{ requestId: "call_1", text: "freeform answer" }],
      }),
    );
  });
});

describe("discordChannel() default event handlers", () => {
  it("posts best-effort typing indicators for turn, authorization, and action progress", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = withState(
      getAdapter(discordChannel({ credentials: { botToken: "bot-token" } })),
      {
        channelId: "C01",
      },
    );
    const { accessor } = captureAccessor("discord:C01:I01");
    const ctx = buildAdapterContext(adapter, accessor);

    await callEvent(adapter, makeEvent("turn.started", {}), ctx);
    await callEvent(
      adapter,
      makeEvent("authorization.completed", {
        name: "notion",
        outcome: "authorized",
        sequence: 0,
        stepIndex: 0,
        turnId: "t1",
      }),
      ctx,
    );
    await callEvent(
      adapter,
      makeEvent("actions.requested", {
        actions: [{ kind: "tool-call", toolName: "search" }],
        sequence: 0,
        turnId: "t1",
      }),
      ctx,
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).toBe("https://discord.com/api/v10/channels/C01/typing");
      expect(new Headers((init as RequestInit).headers).get("authorization")).toBe("Bot bot-token");
      expect((init as RequestInit).body).toBeUndefined();
    }
  });

  it("swallows typing indicator failures", async () => {
    const logs = captureLogRecords();
    const fetchMock = vi.fn().mockRejectedValue(new Error("typing failed"));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = withState(
      getAdapter(discordChannel({ credentials: { botToken: "bot-token" } })),
      {
        channelId: "C01",
      },
    );
    const { accessor } = captureAccessor("discord:C01:I01");
    const ctx = buildAdapterContext(adapter, accessor);

    await expect(
      callAdapterEventHandler(adapter, makeEvent("turn.started", {}), ctx),
    ).resolves.toEqual(makeEvent("turn.started", {}));
    expect(logs.records).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: "adapter event handler threw — event swallowed",
      }),
    );
  });

  it("uses the environment bot token for proactive messages", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ channel_id: "C01", id: "M01" }), {
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = withState(getAdapter(discordChannel()), {
      channelId: "C01",
      initialResponseSent: true,
    });
    const { accessor } = captureAccessor("discord:C01:");
    const ctx = buildAdapterContext(adapter, accessor);
    vi.stubEnv("DISCORD_BOT_TOKEN", "environment-token");

    await callEvent(
      adapter,
      makeEvent("message.completed", {
        finishReason: "stop",
        message: "Hello from the agent",
        sequence: 0,
        stepIndex: 0,
        turnId: "t1",
      }),
      ctx,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://discord.com/api/v10/channels/C01/messages");
    expect(new Headers((init as RequestInit).headers).get("authorization")).toBe(
      "Bot environment-token",
    );
  });

  it("edits the original response and aliases the session on the first post", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ channel_id: "C01", id: "M01" }), {
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = withState(
      getAdapter(
        discordChannel({
          credentials: { applicationId: "APP1", botToken: "bot-token" },
        }),
      ),
      {
        applicationId: "APP1",
        channelId: "C01",
        conversationId: "I01",
        guildId: "G01",
        hasMessageAnchor: false,
        initialResponseSent: false,
        interactionToken: "tok",
      },
    );
    const { accessor, writes } = captureAccessor("discord:C01:I01");
    const ctx = buildAdapterContext(adapter, accessor);

    await callEvent(
      adapter,
      makeEvent("message.completed", {
        finishReason: "stop",
        message: "Hello from the agent",
        sequence: 0,
        stepIndex: 0,
        turnId: "t1",
      }),
      ctx,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://discord.com/api/v10/webhooks/APP1/tok/messages/@original");
    expect((init as RequestInit).method).toBe("PATCH");
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      allowed_mentions: { parse: [] },
      content: "Hello from the agent",
    });
    expect((adapter.state as { conversationId: string }).conversationId).toBe("M01");
    expect(writes.filter(([key]) => key === "eve.continuationToken")).toEqual([
      ["eve.continuationToken", "discord:C01:M01"],
    ]);
  });

  it.each([
    {
      name: "a 1:1 DM shows the link in the open",
      where: { audience: "private", directMessage: true },
      link: true,
    },
    {
      name: "a group DM keeps the link behind a button",
      where: { audience: "private" },
      link: false,
    },
    {
      name: "a session with no known audience keeps the link behind a button",
      where: {},
      link: false,
    },
  ])("posting a sign-in: $name", async ({ where, link }) => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ channel_id: "C01", id: "M01" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = withState(
      getAdapter(discordChannel({ credentials: { applicationId: "APP1", botToken: "bot-token" } })),
      {
        ...where,
        applicationId: "APP1",
        channelId: "C01",
        conversationId: "M00",
        guildId: null,
        hasMessageAnchor: true,
        initialResponseSent: true,
        interactionToken: null,
      },
    );

    await callEvent(
      adapter,
      makeEvent("authorization.required", {
        authorization: { url: "https://calendar.example/sign-in", userCode: "ABCD-1234" },
        description: "Sign in to Calendar",
        name: "calendar",
        principalId: "discord:123",
        sequence: 0,
        stepIndex: 0,
        turnId: "t1",
      }),
      buildAdapterContext(adapter, captureAccessor("discord:C01:M00").accessor),
    );

    const posted = String(fetchMock.mock.calls[0]![1]!.body);
    expect(posted.includes("https://calendar.example/sign-in")).toBe(link);
    expect(posted.includes("ABCD-1234")).toBe(link);
    expect(posted.includes('"label":"Sign in"')).toBe(!link);
  });

  it("receive starts a proactive channel session", async () => {
    const channel = discordChannel({ credentials: { botToken: "bot-token" } });
    const send = vi.fn().mockResolvedValue({ id: "s1" });

    await channel.receive!(
      {
        target: { channelId: "C01" },
        auth: null,
        message: "start",
      },
      {
        ...mockChannelContext(send),
      },
    );

    expect(send).toHaveBeenCalledWith("C01:", {
      auth: null,
      message: "start",
      state: {
        applicationId: null,
        channelId: "C01",
        conversationId: null,
        guildId: null,
        hasMessageAnchor: false,
        initialResponseSent: true,
        interactionToken: null,
      },
    });
  });
});

const RELAY_AUTH = {
  attributes: {},
  authenticator: "test-relay",
  principalId: "relay",
  principalType: "service",
} as const;

function messageCreate(message: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    d: {
      attachments: [],
      author: { id: "U01", username: "ada" },
      channel_id: "C01",
      content: "<@APP1> hello",
      guild_id: "G01",
      id: "M01",
      mentions: [{ id: "APP1" }],
      type: 0,
      ...message,
    },
    op: 0,
    s: 7,
    t: "MESSAGE_CREATE",
  };
}

/** A Gateway-enabled channel whose Discord channel lookups report `channelType`. */
function gatewayChannel(
  options: {
    readonly channelType?: number;
    readonly threadCreation?: "ok" | "refused";
    readonly gateway?: DiscordGatewayConfig;
  } = {},
) {
  const discordFetch = vi.fn<typeof fetch>(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/threads")) {
      return options.threadCreation === "refused"
        ? Response.json({ message: "Missing Permissions" }, { status: 403 })
        : Response.json({ id: "T01", type: 11 });
    }
    if (path.includes("/thread-members/")) return new Response(null, { status: 204 });
    return Response.json({ id: "C01", type: options.channelType ?? 0 });
  });
  const channel = discordChannel({
    api: { fetch: discordFetch },
    credentials: { applicationId: "APP1", botToken: "bot-token" },
    gateway: { auth: () => RELAY_AUTH, ...options.gateway },
  });
  return { channel, discordFetch };
}

async function fireGateway(
  channel: unknown,
  body: unknown,
  options: { readonly activeTokens?: readonly string[]; readonly bearer?: string } = {},
): Promise<{ response: Response; send: ReturnType<typeof vi.fn> }> {
  const route = asCompiled(channel).routes.find(
    (candidate) => isHttpRouteDefinition(candidate) && candidate.path === "/eve/v1/discord/gateway",
  );
  if (!route || !isHttpRouteDefinition(route)) throw new Error("Expected a Gateway route.");
  const send = vi.fn().mockResolvedValue({ id: "s1" });
  const response = await route.handler(
    new Request("https://example.com/eve/v1/discord/gateway", {
      body: JSON.stringify(body),
      headers: options.bearer === undefined ? {} : { authorization: `Bearer ${options.bearer}` },
      method: "POST",
    }),
    {
      ...mockAgentRouteArgs(),
      attachSession: vi.fn() as any,
      ...mockChannelContext(send),
      resolveSession: async (token: string) =>
        options.activeTokens?.includes(token) ? ({ id: "existing" } as any) : undefined,
      to: vi.fn() as any,
      params: {},
      requestIp: null,
      waitUntil: vi.fn(),
    },
  );
  return { response, send };
}

describe("discordChannel() Gateway route", () => {
  it("mounts only when gateway is configured", () => {
    expect(discordChannel({ gateway: {} }).routes.map((route) => route.path)).toEqual([
      "/eve/v1/discord",
      "/eve/v1/discord/gateway",
    ]);
  });

  it("dispatches a direct message to one session per DM channel", async () => {
    const { channel, discordFetch } = gatewayChannel();

    const { response, send } = await fireGateway(
      channel,
      messageCreate({ channel_id: "D01", content: "hi there", guild_id: undefined, mentions: [] }),
    );

    expect(response.status).toBe(202);
    expect(discordFetch).not.toHaveBeenCalled();
    const [token, input] = send.mock.calls[0]!;
    expect(token).toBe("D01:channel");
    expect(input).toMatchObject({
      auth: { authenticator: "discord-interaction", principalId: "discord:U01" },
      message: "hi there",
      state: {
        audience: "private",
        channelId: "D01",
        conversationId: "channel",
        guildId: null,
        hasMessageAnchor: true,
        interactionToken: null,
      },
    });
    expect((input as { context: string[] }).context[0]).toContain("message_id: M01");
  });

  it.each([
    {
      name: "without threads, a mention in a channel starts a new session keyed by the message",
      message: {},
      activeTokens: [],
      token: "C01:M01",
    },
    {
      name: "a reply to the bot continues the session that posted the replied-to message",
      message: {
        content: "and then?",
        mentions: [],
        message_reference: { message_id: "B01" },
        referenced_message: { author: { id: "APP1" }, id: "B01" },
        type: 19,
      },
      activeTokens: ["C01:B01"],
      token: "C01:B01",
    },
    {
      name: "without threads, a reply to a bot message no session owns starts a new session",
      message: {
        content: "and then?",
        mentions: [],
        message_reference: { message_id: "B01" },
        referenced_message: { author: { id: "APP1" }, id: "B01" },
        type: 19,
      },
      activeTokens: [],
      token: "C01:M01",
    },
  ])("$name", async ({ message, activeTokens, token }) => {
    const { channel } = gatewayChannel({ channelType: 0, gateway: { startThread: false } });

    const { send } = await fireGateway(channel, messageCreate(message), { activeTokens });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe(token);
    expect(send.mock.calls[0]![1]).toMatchObject({
      auth: { principalId: "discord:G01:U01" },
      message: expect.stringMatching(/^(hello|and then\?)$/),
    });
  });

  it("starts one session for a whole thread", async () => {
    const { channel } = gatewayChannel({ channelType: 11 });

    const { send } = await fireGateway(channel, messageCreate());

    expect(send.mock.calls[0]![0]).toBe("C01:channel");
  });

  describe("startThread", () => {
    const calls = (discordFetch: ReturnType<typeof gatewayChannel>["discordFetch"]) =>
      discordFetch.mock.calls.map(([input, init]) => ({
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        method: init?.method,
        path: new URL(String(input)).pathname,
      }));

    it("answers a mention in a new thread that holds the session by default", async () => {
      const { channel, discordFetch } = gatewayChannel();

      const { send } = await fireGateway(
        channel,
        messageCreate({ content: "<@APP1> Plan the launch\nwith details" }),
      );

      expect(calls(discordFetch)).toEqual([
        { body: undefined, method: "GET", path: "/api/v10/channels/C01" },
        {
          body: { name: "Plan the launch" },
          method: "POST",
          path: "/api/v10/channels/C01/messages/M01/threads",
        },
        { body: undefined, method: "PUT", path: "/api/v10/channels/T01/thread-members/U01" },
      ]);
      const [token, input] = send.mock.calls[0]!;
      expect(token).toBe("T01:channel");
      expect(input).toMatchObject({ state: { channelId: "T01", conversationId: "channel" } });
    });

    it("lets onMessage start a thread with options or opt out of the default", async () => {
      const { channel, discordFetch } = gatewayChannel({
        gateway: {
          startThread: true,
          onMessage: (_ctx, message) => ({
            auth: defaultDiscordMessageAuth(message),
            startThread: message.content.startsWith("quick")
              ? false
              : { autoArchiveMinutes: 60, name: "Support" },
          }),
        },
      });

      const quick = await fireGateway(channel, messageCreate({ content: "<@APP1> quick one" }));
      const threaded = await fireGateway(channel, messageCreate({ id: "M02" }));

      expect(quick.send.mock.calls[0]![0]).toBe("C01:M01");
      expect(threaded.send.mock.calls[0]![0]).toBe("T01:channel");
      expect(calls(discordFetch)).toContainEqual({
        body: { auto_archive_duration: 60, name: "Support" },
        method: "POST",
        path: "/api/v10/channels/C01/messages/M02/threads",
      });
    });

    it.each([
      { name: "a message already in a thread", channelType: 11, token: "C01:channel" },
      { name: "a refused thread creation", threadCreation: "refused" as const, token: "C01:M01" },
    ])(
      "answers where the message is after $name",
      async ({ channelType, threadCreation, token }) => {
        const { channel } = gatewayChannel({
          channelType,
          gateway: { startThread: true },
          threadCreation,
        });

        const { send } = await fireGateway(channel, messageCreate());

        expect(send.mock.calls[0]![0]).toBe(token);
      },
    );
  });

  it("continues a thread conversation without a mention", async () => {
    const { channel, discordFetch } = gatewayChannel();

    const { send } = await fireGateway(
      channel,
      messageCreate({ content: "one more thing", mentions: [] }),
      { activeTokens: ["C01:channel"] },
    );

    expect(discordFetch).not.toHaveBeenCalled();
    expect(send.mock.calls[0]![0]).toBe("C01:channel");
  });

  it("ignores channel messages that are not for the bot", async () => {
    const { channel } = gatewayChannel();

    const { response, send } = await fireGateway(
      channel,
      messageCreate({ content: "just chatting", mentions: [] }),
    );

    await expect(response.json()).resolves.toEqual({ accepted: false, reason: "not_accepted" });
    expect(send).not.toHaveBeenCalled();
  });

  it("never dispatches messages from bots, including its own replies", async () => {
    const onMessage = vi.fn(() => ({ auth: null }));
    const { channel } = gatewayChannel({ gateway: { onMessage } });

    const { send } = await fireGateway(
      channel,
      messageCreate({ author: { bot: true, id: "APP1", username: "eve" } }),
    );

    expect(onMessage).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("lets onMessage accept messages the default would ignore and choose their session", async () => {
    const { channel, discordFetch } = gatewayChannel({
      gateway: {
        onMessage: (_ctx, message) => ({
          auth: defaultDiscordMessageAuth(message),
          context: [`addressed: ${message.addressed}`],
          conversation: `user:${message.author.id}`,
          startThread: false,
        }),
      },
    });

    const { send } = await fireGateway(
      channel,
      messageCreate({ content: "anyone around?", mentions: [] }),
    );

    expect(discordFetch).not.toHaveBeenCalled();
    expect(send.mock.calls[0]![0]).toBe("C01:user:U01");
    expect(send.mock.calls[0]![1]).toMatchObject({
      context: [expect.stringContaining("<discord_context>"), "addressed: false"],
      message: "anyone around?",
    });
  });

  it("rejects dispatches over 1 MB", async () => {
    const { channel } = gatewayChannel();

    const { response, send } = await fireGateway(
      channel,
      messageCreate({ content: "x".repeat(1024 * 1024) }),
    );

    expect(response.status).toBe(413);
    expect(send).not.toHaveBeenCalled();
  });

  it("aliases every reply in a Gateway session without re-keying it", async () => {
    let nextId = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ channel_id: "C01", id: `B0${++nextId}` })),
    );
    const adapter = withState(
      getAdapter(discordChannel({ credentials: { applicationId: "APP1", botToken: "bot-token" } })),
      {
        applicationId: "APP1",
        channelId: "C01",
        conversationId: "M01",
        guildId: "G01",
        hasMessageAnchor: true,
        initialResponseSent: true,
        interactionToken: null,
      },
    );
    const { accessor, writes } = captureAccessor("discord:C01:M01");

    await callEvent(
      adapter,
      makeEvent("message.completed", {
        finishReason: "stop",
        message: `${"a".repeat(1990)}\n${"b".repeat(100)}`,
        sequence: 0,
        stepIndex: 0,
        turnId: "t1",
      }),
      buildAdapterContext(adapter, accessor),
    );

    expect((adapter.state as { conversationId: string }).conversationId).toBe("M01");
    expect(writes.filter(([key]) => key === "eve.continuationToken")).toEqual([
      ["eve.continuationToken", "discord:C01:B01"],
      ["eve.continuationToken", "discord:C01:B02"],
    ]);
  });

  it("accepts only this project's runtime in the same environment by default", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_bot");
    vi.stubEnv("VERCEL_TARGET_ENV", "production");
    const issuer = await installMockedVercelIssuer("discord-gateway-route");
    const tokenFrom = (environment: string) =>
      issuer.signToken({
        environment,
        project_id: "prj_bot",
        sub: `owner:acme:project:bot:environment:${environment}`,
      });
    const channel = discordChannel({
      credentials: { applicationId: "APP1", botToken: "bot-token" },
      gateway: {},
    });
    const dm = messageCreate({ guild_id: undefined });

    try {
      const unauthenticated = await fireGateway(channel, dm);
      const preview = await fireGateway(channel, dm, { bearer: await tokenFrom("preview") });
      const production = await fireGateway(channel, dm, { bearer: await tokenFrom("production") });

      expect(unauthenticated.response.status).toBe(401);
      expect(preview.response.status).toBe(401);
      expect(preview.send).not.toHaveBeenCalled();
      expect(production.response.status).toBe(202);
    } finally {
      issuer.restore();
    }
  });
});

describe("defaultDiscordAuth", () => {
  it("gives a person the same principal for messages and interactions", () => {
    const user = { id: "U01", isBot: false, username: "ada" };
    const fromInteraction = defaultDiscordAuth({
      applicationId: "APP1",
      channelId: "C01",
      guildId: "G01",
      id: "I01",
      raw: {},
      token: "tok",
      user,
    });
    const fromMessage = defaultDiscordMessageAuth({
      addressed: true,
      attachments: [],
      author: user,
      channelId: "C02",
      content: "hi",
      guildId: "G01",
      id: "M01",
      raw: {},
    });

    for (const field of ["authenticator", "issuer", "principalId", "principalType"] as const) {
      expect(fromMessage[field]).toBe(fromInteraction[field]);
    }
  });

  it("derives guild-scoped user auth", () => {
    const auth = defaultDiscordAuth({
      applicationId: "APP1",
      channelId: "C01",
      guildId: "G01",
      id: "I01",
      raw: {},
      token: "tok",
      user: { id: "U01", isBot: false, username: "ada" },
    });

    expect(auth).toMatchObject({
      attributes: {
        channel_id: "C01",
        guild_id: "G01",
        interaction_id: "I01",
        user_id: "U01",
      },
      authenticator: "discord-interaction",
      principalId: "discord:G01:U01",
      principalType: "user",
    });
  });
});
