import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler, type ChannelAdapter } from "#channel/adapter.js";
import { isCompiledChannel, type CompiledChannel } from "#channel/compiled-channel.js";
import { isHttpRouteDefinition } from "#channel/routes.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import {
  DISCORD_HITL_FREEFORM_TEXT_INPUT_ID,
  renderInputRequestComponents,
} from "#public/channels/discord/hitl.js";
import { defaultDiscordAuth, discordChannel } from "#public/channels/discord/index.js";

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
  event: HandleMessageStreamEvent,
  ctx: any,
): Promise<HandleMessageStreamEvent> {
  return contextStorage.run(stubAlsContext, () => callAdapterEventHandler(adapter, event, ctx));
}

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

function makeEvent<T extends HandleMessageStreamEvent["type"]>(
  type: T,
  data: unknown,
): HandleMessageStreamEvent {
  return { type, data } as HandleMessageStreamEvent;
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
): Promise<{
  response: Response;
  send: ReturnType<typeof vi.fn>;
  waitUntil: ReturnType<typeof vi.fn>;
}> {
  const compiled = asCompiled(channel);
  const post = compiled.routes.find((route) => route.method === "POST");
  if (!post || !isHttpRouteDefinition(post)) {
    throw new Error("Expected discord channel to define a POST route.");
  }
  const send = vi.fn().mockResolvedValue({ continuationToken: "ct", id: "s1" });
  const waitUntil = vi.fn();

  const response = await post.handler(request, {
    getSession: vi.fn() as any,
    params: {},
    requestIp: null,
    send,
    waitUntil,
  } as any);

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
    const channel = discordChannel({ credentials: { publicKey: publicKeyHex } });

    const { response, send } = await firePost(
      channel,
      signedRequest({ body: commandBody(), privateKey }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ type: 5 });
    expect(send).toHaveBeenCalledTimes(1);
    const [payload, options] = send.mock.calls[0]!;
    expect((payload as { context: string[] }).context[0]).toContain("<discord_context>");
    expect(String((payload as { message: string }).message)).toContain("hello discord");
    expect(options).toMatchObject({
      auth: {
        authenticator: "discord-interaction",
        principalId: "discord:G01:U01",
      },
      continuationToken: "C01:I01",
      state: {
        applicationId: "APP1",
        channelId: "C01",
        conversationId: "I01",
        guildId: "G01",
        hasMessageAnchor: false,
        initialResponseSent: false,
        interactionToken: "tok",
      },
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
  });

  it("delivers HITL button clicks as inputResponses", async () => {
    const { privateKey, publicKeyHex } = testKeys();
    const components = renderInputRequestComponents({
      action: { callId: "call_1", input: {}, kind: "tool-call", toolName: "ask_question" },
      options: [{ id: "approve", label: "Approve" }],
      prompt: "Approve?",
      requestId: "call_1",
    });
    const customId = (components[0] as { components: Array<{ custom_id: string }> }).components[0]!
      .custom_id;
    const body = JSON.stringify({
      application_id: "APP1",
      channel_id: "C01",
      data: { component_type: 2, custom_id: customId },
      id: "I02",
      message: { id: "M01" },
      token: "tok2",
      type: 3,
      user: { id: "U01", username: "ada" },
      version: 1,
    });
    const channel = discordChannel({ credentials: { publicKey: publicKeyHex } });

    const { response, send } = await firePost(channel, signedRequest({ body, privateKey }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ type: 6 });
    expect(send).toHaveBeenCalledWith(
      { inputResponses: [{ optionId: "approve", requestId: "call_1" }] },
      expect.objectContaining({
        auth: null,
        continuationToken: "C01:M01",
      }),
    );
  });

  it("opens and resolves freeform HITL modals", async () => {
    const { privateKey, publicKeyHex } = testKeys();
    const components = renderInputRequestComponents({
      action: { callId: "call_1", input: {}, kind: "tool-call", toolName: "ask_question" },
      allowFreeform: true,
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
      { inputResponses: [{ requestId: "call_1", text: "freeform answer" }] },
      expect.objectContaining({
        continuationToken: "C01:M01",
      }),
    );
  });
});

describe("discordChannel() default event handlers", () => {
  it("posts best-effort typing indicators for turn and action progress", async () => {
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
      makeEvent("actions.requested", {
        actions: [{ kind: "tool-call", toolName: "search" }],
        sequence: 0,
        turnId: "t1",
      }),
      ctx,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).toBe("https://discord.com/api/v10/channels/C01/typing");
      expect(new Headers((init as RequestInit).headers).get("authorization")).toBe("Bot bot-token");
      expect((init as RequestInit).body).toBeUndefined();
    }
  });

  it("swallows typing indicator failures", async () => {
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
  });

  it("edits the original response and rekeys the session on the first post", async () => {
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

  it("receive starts a proactive channel session", async () => {
    const channel = discordChannel({ credentials: { botToken: "bot-token" } });
    const send = vi.fn().mockResolvedValue({ continuationToken: "C01:", id: "s1" });

    await channel.receive!(
      {
        target: { channelId: "C01" },
        auth: null,
        message: "start",
      },
      { send },
    );

    expect(send).toHaveBeenCalledWith("start", {
      auth: null,
      continuationToken: "C01:",
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

describe("defaultDiscordAuth", () => {
  it("derives guild-scoped user auth", () => {
    const auth = defaultDiscordAuth({
      applicationId: "APP1",
      channelId: "C01",
      commandName: "ask",
      guildId: "G01",
      id: "I01",
      options: [],
      raw: {},
      token: "tok",
      type: 2,
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
