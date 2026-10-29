import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isCompiledChannel } from "#channel/compiled-channel.js";
import { isHttpRouteDefinition } from "#channel/routes.js";
import type { ChannelFrom } from "#channel/channel-operations.js";
import {
  mockChannelContext,
  type ObservedChannelDelivery,
} from "#internal/testing/mocks/mock-channel-operations.js";
import { mockAgentRouteArgs } from "#internal/testing/mocks/mock-route-args.js";
import { decodeSlackApiBody } from "#internal/testing/slack-api-body.js";
import { ANSWER_ACTION_PREFIX } from "#public/channels/slack/hitl.js";
import { buildSlackAuthContext } from "#public/channels/slack/auth.js";
import { slackChannel, type SlackChannelState } from "#public/channels/slack/slackChannel.js";
import { buildAdapterContext } from "#channel/adapter-context.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import { postCompletedSlackReply } from "#public/channels/slack/index.js";
import { emptySessionView } from "#protocol/session-projection/fold.js";
import type { SessionEvent } from "#protocol/session-event.js";

const SIGNING_SECRET = "test-signing-secret";
let fetchMock: ReturnType<typeof vi.fn>;
let counter = 0;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function decodeBody(init?: RequestInit): Record<string, unknown> {
  if (!init?.body) return {};
  return decodeSlackApiBody(
    init.body,
    init.headers ? new Headers(init.headers).get("content-type") : null,
  ) as Record<string, unknown>;
}
function slackCalls(operation: string): Array<[unknown, RequestInit | undefined]> {
  return fetchMock.mock.calls.filter(
    ([url]) => String(url) === `https://slack.com/api/${operation}`,
  ) as Array<[unknown, RequestInit | undefined]>;
}
function statuses(): unknown[] {
  return slackCalls("agents.sessions.setStatus").map(([, init]) => decodeBody(init).status);
}
function buildSignedRequest({
  body,
  contentType = "application/json",
}: {
  body: string;
  contentType?: string;
}): Request {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = `v0=${createHmac("sha256", SIGNING_SECRET).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return new Request("https://example.com/eve/v1/slack", {
    method: "POST",
    body,
    headers: {
      "content-type": contentType,
      "x-slack-request-timestamp": String(timestamp),
      "x-slack-signature": signature,
    },
  });
}
function buildSignedInteractionRequest(payload: Record<string, unknown>): Request {
  return buildSignedRequest({
    body: new URLSearchParams({ payload: JSON.stringify(payload) }).toString(),
    contentType: "application/x-www-form-urlencoded",
  });
}
function buildEventBody(
  event: Record<string, unknown>,
  options: { authorizations?: readonly Record<string, unknown>[]; eventId?: string } = {},
): string {
  return JSON.stringify({
    api_app_id: "A01",
    authorizations: options.authorizations,
    event,
    event_id: options.eventId ?? `Ev${++counter}`,
    team_id: "T01",
    type: "event_callback",
  });
}
function buildMentionBody({
  channel = "C01",
  ts,
  threadTs,
  user = "U01",
}: { channel?: string; ts?: string; threadTs?: string; user?: string } = {}): { body: string } {
  const stamp = ts ?? `1700000000.${String(++counter).padStart(6, "0")}`;
  return {
    body: buildEventBody({
      channel,
      event_ts: stamp,
      text: "hello",
      ...(threadTs !== undefined && { thread_ts: threadTs }),
      ts: stamp,
      type: "app_mention",
      user,
    }),
  };
}
async function firePost(
  channel: unknown,
  request: Request,
  options: { cancelResult?: "ignored" | "completed" } = {},
) {
  if (!isCompiledChannel(channel)) throw new Error("Expected compiled channel");
  const post = channel.routes.find((route) => route.method === "POST");
  if (!post || !isHttpRouteDefinition(post)) throw new Error("Expected POST route");
  const send = vi.fn().mockResolvedValue({ sessionId: "s1", deliveryId: "d1" });
  const cancel = vi.fn().mockImplementation(async () => ({
    sessionId: "s1",
    deliveryId: "d1",
    result: async () => ({ outcome: options.cancelResult ?? "completed" }),
  }));
  const baseFrom = mockChannelContext<SlackChannelState>(
    send as (address: string, input: ObservedChannelDelivery<SlackChannelState>) => unknown,
  ).from;
  const from: ChannelFrom<SlackChannelState> = (address) => ({
    ...baseFrom(address),
    cancel: (args) => cancel(address, args) as never,
  });
  const waitUntil = vi.fn();
  const response = await post.handler(request, {
    ...mockAgentRouteArgs(),
    from,
    resolveSession: async () => undefined,
    waitUntil,
    attachSession: vi.fn() as never,
    to: vi.fn() as never,
    params: {},
    requestIp: null,
  });
  let drained = 0;
  while (drained < waitUntil.mock.calls.length) {
    const pending = waitUntil.mock.calls.slice(drained).map(([task]) => task as Promise<unknown>);
    drained = waitUntil.mock.calls.length;
    await Promise.allSettled(pending);
  }
  return { send, cancel, response };
}
function renderingHarness() {
  const definition = slackChannel({ credentials: { botToken: "xoxb-test" } });
  if (!isCompiledChannel(definition)) throw new Error("Expected compiled channel");
  const adapter = {
    ...definition.adapter,
    state: {
      ...definition.adapter.state,
      channelId: "C01",
      threadTs: null,
      teamId: "T01",
      codeChannel: true,
    },
  };
  const store = new ContextContainer();
  store.setVirtualContext(SessionKey, {
    sessionId: "s1",
    auth: { current: null, initiator: null },
    turn: { id: "t1", sequence: 0 },
  });
  const ctx = {
    ...buildAdapterContext(adapter, { get: () => undefined, set: () => {} } as never),
    view: emptySessionView(),
  };
  return {
    channel: ctx,
    async event(fact: SessionEvent) {
      const handler = adapter[fact.type] as
        | ((event: SessionEvent, context: typeof ctx) => Promise<void>)
        | undefined;
      if (!handler) throw new Error(`No handler for ${fact.type}`);
      await contextStorage.run(store, () => handler(fact, ctx));
    },
    async deliver(replyThreadTs: string) {
      await adapter.deliver?.({ message: "hello", state: { replyThreadTs } } as never, ctx);
    },
  };
}

describe("slackChannel() code channels", () => {
  const BOT_AUTHORIZATIONS = [{ is_bot: true, user_id: "U_BOT" }];

  // Each test uses its own channel ids: eve caches code channel detection per process.
  function useCodeChannels(codeChannelIds: readonly string[]): void {
    fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      if (!String(request).includes("conversations.info")) {
        return Response.json({ ok: true, ts: "1700000001.000001" });
      }
      const { channel } = decodeBody(init);
      return Response.json({
        ok: true,
        channel: codeChannelIds.includes(String(channel))
          ? {
              is_private: false,
              properties: { record_channel: { record_type: "agent_channel" } },
            }
          : { is_private: false },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
  }

  function channelMessage(input: {
    readonly blocks?: readonly unknown[];
    readonly channel: string;
    readonly threadTs?: string;
    readonly user: string;
  }): string {
    return buildEventBody(
      {
        blocks: input.blocks,
        channel: input.channel,
        channel_type: "channel",
        text: "keep going",
        thread_ts: input.threadTs,
        ts: "1700000000.000300",
        type: "message",
        user: input.user,
      },
      { authorizations: BOT_AUTHORIZATIONS },
    );
  }

  it("lets a mention hook open a code channel and start its session there", async () => {
    fetchMock = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/agents.conversations.create")
        ? Response.json({ ok: true, channel_id: "C_CODE_OPENED" })
        : Response.json({ ok: true, channel: { is_private: false }, ts: "1700000001.000001" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const channel = slackChannel({
      codeChannels: true,
      credentials: { botToken: "xoxb-test", signingSecret: SIGNING_SECRET },
      async onAppMention(ctx, message) {
        const opened = await ctx.openCodeChannel({ name: "Fix the login test" });
        await opened.send(message.text);
        return null;
      },
    });
    const mention = buildMentionBody({
      channel: "C_ORIGIN_OPEN",
      threadTs: "1700000000.000100",
      ts: "1700000000.000200",
      user: "U_ALICE",
    });

    const { send } = await firePost(channel, buildSignedRequest({ body: mention.body }));

    expect(decodeBody(slackCalls("agents.conversations.create")[0]![1])).toMatchObject({
      name: "Fix the login test",
      origin_channel_id: "C_ORIGIN_OPEN",
      origin_message_ts: "1700000000.000200",
    });
    expect(send.mock.calls.map(([address]) => address)).toEqual(["code:C_CODE_OPENED"]);
    const input = send.mock.calls[0]![1];
    expect(input.state).toMatchObject({
      audience: "public",
      channelId: "C_CODE_OPENED",
      codeChannel: true,
      threadTs: null,
      triggeringUserId: "U_ALICE",
    });
    expect(input.auth.attributes).toMatchObject({ channel_id: "C_CODE_OPENED" });
    expect(input.auth.attributes).not.toHaveProperty("thread_ts");
  });

  it("serves a mention as the channel's one session and replies top-level", async () => {
    useCodeChannels(["C_CODE_MENTION"]);
    let isCodeChannel: boolean | undefined;
    const channel = slackChannel({
      codeChannels: true,
      credentials: { botToken: "xoxb-test", signingSecret: SIGNING_SECRET },
      async onAppMention(ctx) {
        isCodeChannel = ctx.slack.codeChannel;
        await ctx.thread.post("On it");
        return { auth: null };
      },
    });
    const mention = buildMentionBody({
      channel: "C_CODE_MENTION",
      ts: "1700000000.000200",
      user: "U_ALICE",
    });

    const { send } = await firePost(channel, buildSignedRequest({ body: mention.body }));

    expect(isCodeChannel).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe("code:C_CODE_MENTION");
    expect(send.mock.calls[0]![1].state).toMatchObject({ codeChannel: true, threadTs: null });
    const post = decodeBody(slackCalls("chat.postMessage")[0]![1]);
    expect(post).toMatchObject({ channel: "C_CODE_MENTION", markdown_text: "On it" });
    expect(post.thread_ts).toBeUndefined();
    expect(slackCalls("assistant.threads.setStatus")).toHaveLength(0);
    expect(slackCalls("agents.sessions.setStatus").map(([, init]) => decodeBody(init))).toEqual([
      { channel_id: "C_CODE_MENTION", status: "processing" },
    ]);
  });

  it("answers un-mentioned messages from any member when codeChannels is set", async () => {
    useCodeChannels(["C_CODE_UNMENTIONED"]);
    const channel = slackChannel({
      codeChannels: true,
      credentials: { botToken: "xoxb-test", signingSecret: SIGNING_SECRET },
    });

    const threaded = await firePost(
      channel,
      buildSignedRequest({
        body: channelMessage({
          channel: "C_CODE_UNMENTIONED",
          threadTs: "1700000000.000100",
          user: "U_ALICE",
        }),
      }),
    );
    const topLevel = await firePost(
      channel,
      buildSignedRequest({
        body: channelMessage({ channel: "C_CODE_UNMENTIONED", user: "U_BOB" }),
      }),
    );
    const originContext = await firePost(
      channel,
      buildSignedRequest({
        body: channelMessage({
          blocks: [{ block_id: "agent_channel_origin_context", type: "context" }],
          channel: "C_CODE_UNMENTIONED",
          user: "U_ALICE",
        }),
      }),
    );
    const ordinary = await firePost(
      channel,
      buildSignedRequest({ body: channelMessage({ channel: "C_ORDINARY", user: "U_ALICE" }) }),
    );

    expect(threaded.send.mock.calls.map(([address]) => address)).toEqual([
      "code:C_CODE_UNMENTIONED",
    ]);
    expect(topLevel.send.mock.calls.map(([address]) => address)).toEqual([
      "code:C_CODE_UNMENTIONED",
    ]);
    // Replies follow the thread the person wrote in.
    expect(threaded.send.mock.calls[0]![1].state).toMatchObject({
      codeChannel: true,
      replyThreadTs: "1700000000.000100",
      threadTs: null,
    });
    expect(topLevel.send.mock.calls[0]![1].state).toMatchObject({ replyThreadTs: null });
    // State and auth report no thread.
    expect(topLevel.send.mock.calls[0]![1].auth.attributes).not.toHaveProperty("thread_ts");
    expect(originContext.send).not.toHaveBeenCalled();
    expect(ordinary.send).not.toHaveBeenCalled();
  });

  // An authored mention handler gates un-mentioned code channel messages, which don't mention the bot.
  it("sends un-mentioned code channel messages to onAppMention without counting them as mentions", async () => {
    useCodeChannels(["C_CODE_HOOK"]);
    const calls: string[] = [];
    const channel = slackChannel({
      codeChannels: true,
      credentials: { botToken: "xoxb-test", signingSecret: SIGNING_SECRET },
      onAppMention(ctx, message) {
        calls.push(`mention:${message.channelId}:${String(ctx.isBotMentioned())}`);
        return { auth: null };
      },
    });

    const unmentioned = await firePost(
      channel,
      buildSignedRequest({ body: channelMessage({ channel: "C_CODE_HOOK", user: "U_ALICE" }) }),
    );
    await firePost(
      channel,
      buildSignedRequest({
        body: buildMentionBody({ channel: "C_CODE_HOOK", user: "U_ALICE" }).body,
      }),
    );
    await firePost(
      channel,
      buildSignedRequest({ body: channelMessage({ channel: "C_ORDINARY_HOOK", user: "U_ALICE" }) }),
    );

    expect(calls).toEqual(["mention:C_CODE_HOOK:false", "mention:C_CODE_HOOK:true"]);
    expect(unmentioned.send.mock.calls.map(([address]) => address)).toEqual(["code:C_CODE_HOOK"]);
  });

  it("leaves un-mentioned messages outside code channels to onEvent", async () => {
    useCodeChannels(["C_CODE_ON_EVENT"]);
    const mentions: string[] = [];
    const events: string[] = [];
    const channel = slackChannel({
      codeChannels: true,
      credentials: { botToken: "xoxb-test", signingSecret: SIGNING_SECRET },
      onAppMention(_ctx, message) {
        mentions.push(message.channelId);
        return null;
      },
      onEvent(_ctx, event) {
        events.push(String(event.channel));
      },
    });

    for (const id of ["C_CODE_ON_EVENT", "C_ORDINARY_ON_EVENT"]) {
      await firePost(
        channel,
        buildSignedRequest({ body: channelMessage({ channel: id, user: "U_ALICE" }) }),
      );
    }

    expect(mentions).toEqual(["C_CODE_ON_EVENT"]);
    expect(events).toEqual(["C_ORDINARY_ON_EVENT"]);
  });

  it("treats a code channel as an ordinary channel without codeChannels", async () => {
    useCodeChannels(["C_CODE_OFF"]);
    const isCodeChannel = vi.fn();
    const channel = slackChannel({
      credentials: { botToken: "xoxb-test", signingSecret: SIGNING_SECRET },
      onAppMention(ctx) {
        isCodeChannel(ctx.slack.codeChannel);
        return null;
      },
    });
    const mention = buildMentionBody({ channel: "C_CODE_OFF", ts: "1700000000.000200" });

    await firePost(channel, buildSignedRequest({ body: mention.body }));

    expect(isCodeChannel).toHaveBeenCalledWith(false);
    expect(slackCalls("conversations.info")).toHaveLength(0);
  });

  it("serves a channel whose lookup failed per thread and retries the lookup later", async () => {
    const initialTime = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(initialTime);
    let lookupSucceeds = false;
    fetchMock = vi.fn(async (request: string | URL | Request) =>
      String(request).includes("conversations.info")
        ? lookupSucceeds
          ? Response.json({
              ok: true,
              channel: { properties: { record_channel: { record_type: "agent_channel" } } },
            })
          : Response.json({ ok: false, error: "missing_scope" })
        : Response.json({ ok: true, ts: "1700000001.000001" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const isCodeChannel = vi.fn();
    const channel = slackChannel({
      codeChannels: true,
      credentials: { botToken: "xoxb-test", signingSecret: SIGNING_SECRET },
      onAppMention(ctx) {
        isCodeChannel(ctx.slack.codeChannel);
        return null;
      },
    });

    for (const ts of ["1700000000.000201", "1700000000.000202"]) {
      const mention = buildMentionBody({ channel: "C_LOOKUP_FAILS", ts });
      await firePost(channel, buildSignedRequest({ body: mention.body }));
    }
    expect(isCodeChannel.mock.calls).toEqual([[false], [false]]);
    expect(slackCalls("conversations.info")).toHaveLength(1);

    lookupSucceeds = true;
    now.mockReturnValue(initialTime + 60_001);
    await firePost(
      channel,
      buildSignedRequest({ body: buildMentionBody({ channel: "C_LOOKUP_FAILS" }).body }),
    );
    expect(isCodeChannel.mock.calls).toEqual([[false], [false], [true]]);
    expect(slackCalls("conversations.info")).toHaveLength(2);
  });

  it("gates un-mentioned messages with an authored onAppMention without touching the status", async () => {
    useCodeChannels(["C_CODE_GATED"]);
    const channel = slackChannel({
      codeChannels: true,
      credentials: { botToken: "xoxb-test", signingSecret: SIGNING_SECRET },
      onAppMention: (_ctx, message) =>
        message.author?.userId === "U_ALICE" ? { auth: null } : null,
    });

    const bob = await firePost(
      channel,
      buildSignedRequest({ body: channelMessage({ channel: "C_CODE_GATED", user: "U_BOB" }) }),
    );
    expect(bob.send).not.toHaveBeenCalled();
    // Bob's dropped message may arrive mid-turn, so it leaves the session status alone.
    expect(slackCalls("agents.sessions.setStatus")).toHaveLength(0);

    const alice = await firePost(
      channel,
      buildSignedRequest({ body: channelMessage({ channel: "C_CODE_GATED", user: "U_ALICE" }) }),
    );
    expect(alice.send.mock.calls.map(([address]) => address)).toEqual(["code:C_CODE_GATED"]);
  });

  it("addresses a custom interaction in a code channel to the channel's session", async () => {
    useCodeChannels(["C_CODE_CARD"]);
    const channel = slackChannel({
      codeChannels: true,
      credentials: { botToken: "xoxb-test", signingSecret: SIGNING_SECRET },
      async onInteraction(_action, ctx) {
        await ctx.thread.post("Rerunning.");
        await ctx.cancel({ turnId: "turn_observed" });
      },
    });

    const { cancel } = await firePost(
      channel,
      buildSignedInteractionRequest({
        type: "block_actions",
        team: { id: "T01" },
        user: { id: "U01", username: "ada" },
        channel: { id: "C_CODE_CARD" },
        message: { ts: "1700000000.000010", thread_ts: "1700000000.000001", blocks: [] },
        actions: [{ action_id: "rerun", text: { type: "plain_text", text: "Rerun" } }],
      }),
    );
    await vi.waitFor(() => expect(cancel).toHaveBeenCalled());

    expect(cancel).toHaveBeenCalledWith("code:C_CODE_CARD", { turnId: "turn_observed" });
    // The card sits in a thread, so the reply stays there.
    expect(decodeBody(slackCalls("chat.postMessage")[0]![1])).toMatchObject({
      channel: "C_CODE_CARD",
      thread_ts: "1700000000.000001",
    });
  });

  // A code channel card routes to the channel's session, which has no thread.
  it("answers a code channel's approval card on the channel's session", async () => {
    useCodeChannels(["C_CODE_HITL"]);
    let codeChannel: boolean | undefined;
    const channel = slackChannel({
      codeChannels: true,
      credentials: { botToken: "xoxb-test", signingSecret: SIGNING_SECRET },
      onAnswers(ctx) {
        codeChannel = ctx.slack.codeChannel;
        return { auth: ctx.defaultAuth };
      },
    });

    const { send } = await firePost(
      channel,
      buildSignedInteractionRequest({
        type: "block_actions",
        team: { id: "T01" },
        user: { id: "U01", username: "ada", team_id: "T01" },
        channel: { id: "C_CODE_HITL" },
        message: { ts: "1700000000.000010", blocks: [] },
        actions: [
          {
            action_id: `${ANSWER_ACTION_PREFIX}code:C_CODE_HITL:tool-approval:approval_abc123:button:0`,
            text: { type: "plain_text", text: "Approve" },
            value: "approve",
          },
        ],
      }),
    );
    await vi.waitFor(() => expect(send).toHaveBeenCalled());

    expect(send.mock.calls[0]![0]).toBe("code:C_CODE_HITL");
    expect(codeChannel).toBe(true);
    expect(send.mock.calls[0]![1].auth.attributes).not.toHaveProperty("thread_ts");
  });

  it("cancels the session's turn when Slack stops the code channel session", async () => {
    useCodeChannels([]);
    const channel = slackChannel({
      codeChannels: true,
      credentials: { botToken: "xoxb-test", signingSecret: SIGNING_SECRET },
    });
    const body = buildEventBody({
      channel: "C_CODE_STOP",
      type: "agent_session_stopped",
      user: "U1",
    });

    const { cancel, send } = await firePost(channel, buildSignedRequest({ body }));

    expect(cancel).toHaveBeenCalledWith("code:C_CODE_STOP", undefined);
    expect(send).not.toHaveBeenCalled();
  });

  // A turn that died without ending leaves `processing` up, which never times out.
  it("resets the status to active when a stop finds no active turn", async () => {
    useCodeChannels([]);
    const channel = slackChannel({
      codeChannels: true,
      credentials: { botToken: "xoxb-test", signingSecret: SIGNING_SECRET },
    });
    const body = buildEventBody({
      channel: "C_CODE_STUCK",
      type: "agent_session_stopped",
      user: "U1",
    });

    await firePost(channel, buildSignedRequest({ body }), {
      cancelResult: "ignored",
    });

    expect(slackCalls("agents.sessions.setStatus").map(([, init]) => decodeBody(init))).toEqual([
      { channel_id: "C_CODE_STUCK", status: "active" },
    ]);
  });

  it("leaves a stop to onEvent without codeChannels", async () => {
    useCodeChannels([]);
    const onEvent = vi.fn();
    const channel = slackChannel({
      credentials: { botToken: "xoxb-test", signingSecret: SIGNING_SECRET },
      onEvent,
    });
    const body = buildEventBody({
      channel: "C_STOP_OFF",
      type: "agent_session_stopped",
      user: "U1",
    });

    const { cancel } = await firePost(channel, buildSignedRequest({ body }));

    await vi.waitFor(() => expect(onEvent).toHaveBeenCalled());
    expect(cancel).not.toHaveBeenCalled();
  });

  it("cancels once for a stop in a code channel thread, even when Slack redelivers it", async () => {
    useCodeChannels(["C_CODE_THREAD_STOP"]);
    const channel = slackChannel({
      codeChannels: true,
      credentials: { botToken: "xoxb-test", signingSecret: SIGNING_SECRET },
    });
    const body = buildEventBody(
      {
        channel: "C_CODE_THREAD_STOP",
        thread_ts: "1700000000.000100",
        type: "agent_session_stopped",
        user: "U1",
      },
      { eventId: "Ev_STOP_THREAD" },
    );

    const first = await firePost(channel, buildSignedRequest({ body }));
    const redelivered = await firePost(channel, buildSignedRequest({ body }));

    await vi.waitFor(() =>
      expect(first.cancel).toHaveBeenCalledWith("code:C_CODE_THREAD_STOP", undefined),
    );
    expect(redelivered.cancel).not.toHaveBeenCalled();
  });

  it("leaves a stop in an ordinary thread to onEvent with codeChannels", async () => {
    useCodeChannels([]);
    const onEvent = vi.fn();
    const channel = slackChannel({
      codeChannels: true,
      credentials: { botToken: "xoxb-test", signingSecret: SIGNING_SECRET },
      onEvent,
    });
    const body = buildEventBody({
      channel: "C_THREAD_STOP",
      thread_ts: "1700000000.000100",
      type: "agent_session_stopped",
      user: "U1",
    });

    const { cancel } = await firePost(channel, buildSignedRequest({ body }));

    await vi.waitFor(() => expect(onEvent).toHaveBeenCalled());
    expect(cancel).not.toHaveBeenCalled();
  });

  it("suspends the session status while a turn waits on input", async () => {
    useCodeChannels([]);
    const { event } = renderingHarness();
    await event({
      type: "turn.started",
      data: { cause: { deliveryId: "d1" }, follows: null, turnId: "t1" },
    });
    await event({
      type: "turn.paused",
      data: { turnId: "t1", awaiting: [{ interactionId: "approval-1" }] },
    });
    await event({ type: "turn.settled", data: { turnId: "t1", outcome: "completed" } });
    expect(statuses()).toEqual(["processing", "suspended", "active"]);
  });

  it("replies in the thread of the message that started the turn", async () => {
    useCodeChannels([]);
    const { event, deliver } = renderingHarness();
    await deliver("1700000000.000100");
    await event({
      type: "turn.started",
      data: { cause: { deliveryId: "d1" }, follows: null, turnId: "t1" },
    });
    await deliver("1700000000.000200");
    await event({
      type: "content.completed",
      data: {
        kind: "text",
        phase: "reply",
        value: "Here's what I found.",
        runId: "r1",
        partId: "p1",
      },
    });
    await event({
      type: "turn.started",
      data: { cause: { deliveryId: "d2" }, follows: "t1", turnId: "t2" },
    });
    await event({
      type: "content.completed",
      data: {
        kind: "text",
        phase: "reply",
        value: "Here's what I found.",
        runId: "r2",
        partId: "p2",
      },
    });
    expect(slackCalls("chat.postMessage").map(([, init]) => decodeBody(init).thread_ts)).toEqual([
      "1700000000.000100",
      "1700000000.000200",
    ]);
    expect(statuses()).toContain("processing");
    expect(slackCalls("assistant.threads.setStatus")).toHaveLength(0);
  });

  it("sets the session back to active when a turn is cancelled", async () => {
    useCodeChannels([]);
    const { event } = renderingHarness();
    await event({
      type: "turn.started",
      data: { cause: { deliveryId: "d1" }, follows: null, turnId: "t1" },
    });
    await event({ type: "turn.settled", data: { turnId: "t1", outcome: "cancelled" } });
    expect(statuses()).toEqual(["processing", "active"]);
  });
});

describe("code channel regressions", () => {
  it("skips the deleted-root check in a code channel", async () => {
    fetchMock = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("chat.getPermalink")
        ? Response.json({ ok: false, error: "message_not_found" })
        : Response.json({ ok: true, ts: "1.1" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { channel } = renderingHarness();
    await postCompletedSlackReply(channel, "hello");
    expect(slackCalls("chat.getPermalink")).toHaveLength(0);
    expect(slackCalls("chat.postMessage")).toHaveLength(1);
  });
  it("cancels a code channel's session from onEvent", async () => {
    fetchMock = vi.fn(async () => Response.json({ ok: true, ts: "1.1" }));
    vi.stubGlobal("fetch", fetchMock);
    const channel = slackChannel({
      credentials: { botToken: "xoxb-test", signingSecret: SIGNING_SECRET },
      async onEvent(ctx) {
        await ctx.cancel({ target: { channelId: "C_CODE", codeChannel: true } });
      },
    });
    const { cancel } = await firePost(
      channel,
      buildSignedRequest({ body: buildEventBody({ type: "reaction_added", user: "U01" }) }),
    );
    expect(cancel).toHaveBeenCalledWith("code:C_CODE", { turnId: undefined });
  });
});

describe("slackChannel().receive code channels", () => {
  const codeChannel = {
    name: "Fix it",
    originThreadTs: "1700000000.000001",
    originTs: "1700000000.000002",
  };

  function receive(codeChannels = true) {
    const operation = slackChannel({
      credentials: { botToken: "xoxb-test" },
      codeChannels,
    }).receive;
    if (!operation) throw new Error("Expected receive operation");
    return operation;
  }

  function stubSlack(createdChannelId: string, isPrivate = false): void {
    fetchMock = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/agents.conversations.create")
        ? Response.json({ ok: true, channel_id: createdChannelId })
        : Response.json({ ok: true, channel: { is_private: isPrivate }, ts: "1700000001.000001" }),
    );
    vi.stubGlobal("fetch", fetchMock);
  }

  it("opens a code channel and starts its session there with auth moved to the channel", async () => {
    stubSlack("C_CODE_RECEIVE");
    const send = vi.fn().mockResolvedValue({ sessionId: "session_code", deliveryId: "delivery_1" });
    const originAuth = buildSlackAuthContext({
      channelId: "C_ORIGIN",
      teamId: "T01",
      threadTs: "1700000000.000001",
      userId: "U_ALICE",
    });

    const delivery = await receive()(
      {
        message: "Start by reproducing it.",
        target: { channelId: "C_ORIGIN", codeChannel },
        auth: originAuth,
      },
      mockChannelContext(send),
    );

    expect(delivery.sessionId).toBe("session_code");
    expect(send).toHaveBeenCalledTimes(1);
    const [address, input] = send.mock.calls[0]!;
    expect(address).toBe("code:C_CODE_RECEIVE");
    expect(input.state).toMatchObject({
      audience: "public",
      channelId: "C_CODE_RECEIVE",
      codeChannel: true,
      threadTs: null,
    });
    expect(input.auth.attributes).toEqual({
      author_type: "user",
      channel_id: "C_CODE_RECEIVE",
      team_id: "T01",
      user_id: "U_ALICE",
    });
    expect(input.auth.principalId).toBe("slack:T01:U_ALICE");
    expect(decodeBody(slackCalls("agents.conversations.create")[0]![1])).toMatchObject({
      origin_channel_id: "C_ORIGIN",
      origin_message_ts: codeChannel.originTs,
      name: "Fix it",
    });
  });

  it("gives a code channel opened from a private origin a private audience", async () => {
    stubSlack("C_CODE_PRIVATE", true);
    const send = vi.fn().mockResolvedValue({ sessionId: "session_private" });

    await receive()(
      {
        message: "Start by reproducing it.",
        target: { channelId: "C_ORIGIN", codeChannel },
        auth: null,
      },
      mockChannelContext(send),
    );

    expect(send.mock.calls[0]![1].state).toMatchObject({ audience: "private", codeChannel: true });
    expect(decodeBody(slackCalls("agents.conversations.create")[0]![1])).toMatchObject({
      is_private: "true",
    });
  });

  it("opens a code channel without a source session", async () => {
    stubSlack("C_CODE_ROUTE");
    const send = vi.fn().mockResolvedValue({ sessionId: "session_route" });

    const delivery = await receive()(
      {
        message: "Start by reproducing it.",
        target: { channelId: "C_ORIGIN", codeChannel },
        auth: null,
      },
      mockChannelContext(send),
    );

    expect(delivery.sessionId).toBe("session_route");
    expect(send.mock.calls.map(([address]) => address)).toEqual(["code:C_CODE_ROUTE"]);
  });

  it("refuses a code channel target without codeChannels", async () => {
    stubSlack("C_NEVER_CREATED");
    const send = vi.fn();

    await expect(
      receive(false)(
        { message: "hi", target: { channelId: "C_ORIGIN", codeChannel }, auth: null },
        mockChannelContext(send),
      ),
    ).rejects.toThrow("set `codeChannels: true`");
    expect(slackCalls("agents.conversations.create")).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a code channel target combined with a thread", async () => {
    stubSlack("C_NEVER_CREATED");
    const send = vi.fn();

    await expect(
      receive()(
        {
          message: "hi",
          target: { channelId: "C_ORIGIN", codeChannel, threadTs: "1" } as never,
          auth: null,
        },
        mockChannelContext(send),
      ),
    ).rejects.toThrow("`codeChannel` can't be combined with `threadTs` or `initialMessage`");
    expect(slackCalls("agents.conversations.create")).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("slackChannel() code channel metadata", () => {
  it("projects the latest delivered message into the channel metadata", async () => {
    const definition = slackChannel();
    if (!isCompiledChannel(definition)) throw new Error("Expected compiled channel");
    const adapter = {
      ...definition.adapter,
      state: {
        ...definition.adapter.state,
        channelId: "C01",
        threadTs: "1700000000.000001",
        teamId: "T01",
        installationTeamId: "T_INSTALL",
        triggeringMessageTs: "1700000000.000002",
      },
    };
    const ctx = buildAdapterContext(adapter, { get: () => undefined, set: () => {} } as never);

    await adapter.deliver?.(
      { message: "And the tests?", state: { triggeringMessageTs: "1700000000.000003" } } as never,
      ctx,
    );

    expect(adapter.instrumentation?.metadata?.(ctx.state)).toMatchObject({
      channelId: "C01",
      installationTeamId: "T_INSTALL",
      threadTs: "1700000000.000001",
      triggeringMessageTs: "1700000000.000003",
    });
  });
});
