import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isCompiledChannel } from "#channel/compiled-channel.js";
import { Card, CardText } from "#public/channels/slack/cards.js";
import type { SlackPostInput } from "#public/channels/slack/api.js";
import { isHttpRouteDefinition } from "#channel/routes.js";
import { SessionStrandedError } from "#channel/session-stranded-error.js";
import {
  mockChannelContext,
  type ObservedChannelDelivery,
} from "#internal/testing/mocks/mock-channel-operations.js";
import { mockAgentRouteArgs } from "#internal/testing/mocks/mock-route-args.js";
import { decodeSlackApiBody } from "#internal/testing/slack-api-body.js";
import {
  slackRenderingHarness,
  type SlackTurnStep,
} from "#internal/testing/slack-rendering-harness.js";
import { ANSWER_ACTION_PREFIX } from "#public/channels/slack/hitl.js";
import { defaultSlackAuth } from "#public/channels/slack/defaults.js";
import {
  slackChannel,
  type SlackChannelConfig,
  type SlackChannelState,
  type SlackInboundMessageContext,
} from "#public/channels/slack/slackChannel.js";
import type { SlackMessage, SlackMessageEdit } from "#public/channels/slack/inbound.js";

const SIGNING_SECRET = "test-signing-secret";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv("SLACK_SIGNING_SECRET", SIGNING_SECRET);
  fetchMock = vi.fn(async (request: string | URL | Request) => {
    const url = String(request);
    if (url.includes("conversations.info"))
      return Response.json({ channel: { is_private: false }, ok: true });
    if (url.endsWith("files.getUploadURLExternal"))
      return Response.json({
        ok: true,
        upload_url: "https://files.slack.com/upload/report",
        file_id: "F01",
      });
    if (url.startsWith("https://files.slack.com/upload/")) return new Response("OK");
    if (url.endsWith("files.completeUploadExternal"))
      return Response.json({ ok: true, files: [{ id: "F01" }] });
    return Response.json({ ok: true, ts: "1700000001.000001" });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function signed(body: string, contentType = "application/json"): Request {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = `v0=${createHmac("sha256", SIGNING_SECRET)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;
  return new Request("https://example.com/eve/v1/slack", {
    body,
    headers: {
      "content-type": contentType,
      "x-slack-request-timestamp": String(timestamp),
      "x-slack-signature": signature,
    },
    method: "POST",
  });
}

function mention(input: { readonly ts: string; readonly threadTs?: string }): Request {
  const event: Record<string, unknown> = {
    channel: "C01",
    event_ts: input.ts,
    text: "hello",
    ts: input.ts,
    type: "app_mention",
    user: "U01",
  };
  if (input.threadTs !== undefined) event.thread_ts = input.threadTs;
  return signed(
    JSON.stringify({ event, event_id: `Ev${input.ts}`, team_id: "T01", type: "event_callback" }),
  );
}

function approvalPress(): Request {
  const payload = {
    actions: [
      {
        action_id: `${ANSWER_ACTION_PREFIX}tool-approval:approval_abc123:button:0`,
        text: { text: "Approve", type: "plain_text" },
        value: "approve",
      },
    ],
    channel: { id: "C01" },
    message: {
      blocks: [{ text: { text: "Approve?", type: "mrkdwn" }, type: "section" }],
      thread_ts: "1700000000.000001",
      ts: "1700000000.000010",
    },
    team: { id: "T01" },
    type: "block_actions",
    user: { id: "U_APPROVER", name: "ada", team_id: "T01", username: "ada" },
  };
  return signed(
    new URLSearchParams({ payload: JSON.stringify(payload) }).toString(),
    "application/x-www-form-urlencoded",
  );
}

/** Posts `request` to the channel's webhook and drains every task it hands to `waitUntil`. */
async function firePost(
  channel: unknown,
  request: Request,
  send: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue({ id: "s1" }),
  resolveSession: () => Promise<unknown> = () => Promise.resolve({ id: "s1" }),
): Promise<void> {
  if (!isCompiledChannel(channel)) throw new Error("Expected a compiled channel.");
  const post = channel.routes.find((route) => route.method === "POST");
  if (!post || !isHttpRouteDefinition(post)) throw new Error("Expected a POST route.");
  const waitUntil = vi.fn();
  await post.handler(request, {
    ...mockAgentRouteArgs(),
    from: mockChannelContext<SlackChannelState>(
      send as (address: string, input: ObservedChannelDelivery<SlackChannelState>) => unknown,
    ).from,
    resolveSession: resolveSession as never,
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
}

function slackCalls(operation: string): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter(([url]) => String(url) === `https://slack.com/api/${operation}`)
    .map(([, init]) => {
      const { body, headers } = (init ?? {}) as RequestInit;
      if (!body) return {};
      const contentType = headers ? new Headers(headers).get("content-type") : null;
      return decodeSlackApiBody(body, contentType) as Record<string, unknown>;
    });
}

describe("slackChannel ephemeral threading", () => {
  const postEphemeralOnMention = () =>
    slackChannel({
      credentials: { botToken: "xoxb-test" },
      async onAppMention(ctx) {
        await ctx.thread.postEphemeral("U01", "text");
        return null;
      },
    });

  // #5012: Slack only shows a threaded ephemeral once the thread has a reply.
  it("omits thread_ts from postEphemeral for a top-level mention", async () => {
    await firePost(postEphemeralOnMention(), mention({ ts: "1700000000.000001" }));

    const ephemeral = slackCalls("chat.postEphemeral");
    expect(ephemeral).toHaveLength(1);
    expect(ephemeral[0]).toMatchObject({ channel: "C01", markdown_text: "text", user: "U01" });
    expect(ephemeral[0]?.thread_ts).toBeUndefined();
  });

  it("keeps thread_ts from postEphemeral for a threaded mention", async () => {
    const rootTs = "1700000000.100000";

    await firePost(
      postEphemeralOnMention(),
      mention({ ts: "1700000000.100001", threadTs: rootTs }),
    );

    const ephemeral = slackCalls("chat.postEphemeral");
    expect(ephemeral).toHaveLength(1);
    expect(ephemeral[0]).toMatchObject({ channel: "C01", markdown_text: "text", user: "U01" });
    expect(ephemeral[0]?.thread_ts).toBe(rootTs);
  });
});

describe("slackChannel inactive prompt press", () => {
  it("retires a HITL card and tells the presser when its session is stranded", async () => {
    const send = vi.fn().mockRejectedValue(new SessionStrandedError({}));

    await firePost(slackChannel({ credentials: { botToken: "xoxb-test" } }), approvalPress(), send);

    const [update] = slackCalls("chat.update");
    expect(update).toMatchObject({ text: "No longer active", ts: "1700000000.000010" });
    // Nobody's answer was taken, so the retired card credits nobody.
    const shown = JSON.stringify(update?.blocks);
    expect(shown).toContain("No longer active");
    expect(shown).not.toContain("U_APPROVER");
    expect(slackCalls("chat.postEphemeral")).toEqual([
      expect.objectContaining({
        markdown_text: "This request is no longer active. Send a new message to start again.",
        thread_ts: "1700000000.000001",
        user: "U_APPROVER",
      }),
    ]);
  });
});

describe("slackChannel ephemeral request press", () => {
  const RESPONSE_URL = "https://hooks.slack.com/actions/T01/1/abc";
  const route = "route:C01:1700000000.000001:";

  /** A press on an ephemeral card: Slack sends no `message`, only its container. */
  function ephemeralPress(action: Record<string, unknown>, { inThread = true } = {}): Request {
    const payload = {
      actions: [action],
      channel: { id: "C01" },
      container: {
        channel_id: "C01",
        is_ephemeral: true,
        message_ts: "1700000000.000020",
        ...(inThread && { thread_ts: "1700000000.000001" }),
        type: "message",
      },
      response_url: RESPONSE_URL,
      team: { id: "T01" },
      trigger_id: "trigger-1",
      type: "block_actions",
      user: { id: "U01", name: "alice", team_id: "T01", username: "alice" },
    };
    return signed(
      new URLSearchParams({ payload: JSON.stringify(payload) }).toString(),
      "application/x-www-form-urlencoded",
    );
  }

  function responseUrlPosts(): Record<string, unknown>[] {
    return fetchMock.mock.calls
      .filter(([url]) => String(url) === RESPONSE_URL)
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
  }

  it.each([
    {
      action: {
        action_id: `${ANSWER_ACTION_PREFIX}${route}q_team`,
        selected_option: { text: { text: "Acme", type: "plain_text" }, value: "team_acme" },
        type: "radio_buttons",
      },
      name: "a picked option",
    },
    {
      // Keeping the preselected option submits it with the select's **Use Acme** button.
      action: {
        action_id: `${ANSWER_ACTION_PREFIX}${route}q_team:button:0`,
        block_id: "eve_use:q_team",
        text: { text: "Use Acme", type: "plain_text" },
        type: "button",
        value: "team_acme",
      },
      name: "the kept preselected option",
    },
  ])("replaces the card with $name through its response URL once delivered", async ({ action }) => {
    const send = vi.fn().mockResolvedValue({ id: "s1" });
    const press = ephemeralPress(action);

    await firePost(slackChannel({ credentials: { botToken: "xoxb-test" } }), press, send);

    expect(send).toHaveBeenCalledOnce();
    expect(slackCalls("chat.update")).toEqual([]);
    const [replaced, ...more] = responseUrlPosts();
    expect(more).toEqual([]);
    expect(replaced).toMatchObject({
      replace_original: true,
      text: "Acme",
      thread_ts: "1700000000.000001",
    });
    expect(JSON.stringify(replaced?.blocks)).toContain("Acme");
  });

  it("keeps a top-level card's replacement out of a thread", async () => {
    const send = vi.fn().mockResolvedValue({ id: "s1" });
    const press = ephemeralPress(
      {
        action_id: `${ANSWER_ACTION_PREFIX}route:C01:1700000000.000020:q_team`,
        selected_option: { text: { text: "Acme", type: "plain_text" }, value: "team_acme" },
        type: "radio_buttons",
      },
      { inThread: false },
    );

    await firePost(slackChannel({ credentials: { botToken: "xoxb-test" } }), press, send);

    const [replaced] = responseUrlPosts();
    expect(replaced).toMatchObject({ replace_original: true, text: "Acme" });
    expect(replaced?.thread_ts).toBeUndefined();
  });

  it("replaces the card with a typed answer from its modal", async () => {
    const channel = slackChannel({ credentials: { botToken: "xoxb-test" } });
    const send = vi.fn().mockResolvedValue({ id: "s1" });
    await firePost(
      channel,
      ephemeralPress({
        action_id: `eve_input_freeform:${route}q_scope`,
        type: "button",
        value: "q_scope",
      }),
      send,
    );
    const [opened] = slackCalls("views.open");
    const view = opened?.view as { private_metadata: string };

    const submission = {
      type: "view_submission",
      user: { id: "U01", name: "alice", team_id: "T01", username: "alice" },
      view: {
        callback_id: "eve_input_freeform_submit",
        private_metadata: view.private_metadata,
        state: {
          values: {
            eve_freeform_block: {
              eve_freeform_text: { type: "plain_text_input", value: "The billing migration" },
            },
          },
        },
        team_id: "T01",
      },
    };
    await firePost(
      channel,
      signed(
        new URLSearchParams({ payload: JSON.stringify(submission) }).toString(),
        "application/x-www-form-urlencoded",
      ),
      send,
    );

    expect(send).toHaveBeenCalledOnce();
    expect(slackCalls("chat.update")).toEqual([]);
    const [replaced] = responseUrlPosts();
    expect(replaced).toMatchObject({
      replace_original: true,
      text: "The billing migration",
      thread_ts: "1700000000.000001",
    });
  });
});

describe("slackChannel action token", () => {
  it("adds Slack's action token to the default auth without a hook", async () => {
    fetchMock.mockImplementation(async () => Response.json({ ok: true, ts: "1700000001.000001" }));
    const channel = slackChannel({ credentials: { botToken: "xoxb-test" } });
    const send = vi.fn().mockResolvedValue({ sessionId: "s1" });
    const event = {
      assistant_thread: { action_token: "action-token" },
      channel: "C01",
      text: "hello",
      ts: "1700000000.000001",
      type: "app_mention",
      user: "U01",
    };

    await firePost(
      channel,
      signed(JSON.stringify({ event, event_id: "Ev1", team_id: "T01", type: "event_callback" })),
      send,
    );

    const [, input] = send.mock.calls[0]! as [string, ObservedChannelDelivery<SlackChannelState>];
    expect(input.auth?.attributes).toMatchObject({ action_token: "action-token" });
  });
});

describe("slackChannel messageContext.users", () => {
  it("resolves the author before the mention hook and adds names to the turn", async () => {
    fetchMock.mockImplementation(async (request: string | URL | Request) => {
      const url = String(request);
      if (url.includes("users.info"))
        return Response.json({
          ok: true,
          user: {
            profile: { display_name: "alice", real_name: "Alice Doe", email: "alice@example.com" },
          },
        });
      if (url.includes("conversations.info"))
        return Response.json({ channel: { is_private: false }, ok: true });
      return Response.json({ ok: true, ts: "1700000001.000001" });
    });
    const onAppMention = vi.fn<NonNullable<SlackChannelConfig["onAppMention"]>>((ctx, message) => ({
      auth: defaultSlackAuth(message, ctx),
    }));
    const channel = slackChannel({
      credentials: { botToken: "xoxb-test" },
      messageContext: { users: true },
      onAppMention,
    });
    const send = vi.fn().mockResolvedValue({ sessionId: "s1" });

    await firePost(channel, mention({ ts: "1700000000.000001" }), send);

    expect(onAppMention.mock.calls[0]?.[1].author).toMatchObject({
      displayName: "alice",
      fullName: "Alice Doe",
    });
    expect(onAppMention.mock.calls[0]?.[1].author?.email).toBeUndefined();
    const [, input] = send.mock.calls[0]! as [string, ObservedChannelDelivery<SlackChannelState>];
    const turn = JSON.stringify("message" in input ? input.message : "");
    expect(turn).toContain("id: U01\\ndisplay_name: alice\\nreal_name: Alice Doe\\n</sender>");
    expect(turn).not.toContain("alice@example.com");
    expect(input.auth?.attributes).toMatchObject({ full_name: "Alice Doe" });
  });

  it("uses an authored resolve instead of the built-in users.info cache", async () => {
    const resolve = vi.fn(async ({ userId }: { readonly userId: string }) => ({
      realName: `cached-${userId}`,
      email: "alice@example.com",
    }));
    const channel = slackChannel({
      credentials: { botToken: "xoxb-test" },
      messageContext: { users: { email: true, resolve } },
      onAppMention: () => ({ auth: null }),
    });
    const send = vi.fn().mockResolvedValue({ sessionId: "s1" });

    await firePost(channel, mention({ ts: "1700000000.000001" }), send);

    expect(resolve).toHaveBeenCalledWith({ userId: "U01", teamId: "T01" }, expect.any(Function));
    const [, input] = send.mock.calls[0]! as [string, ObservedChannelDelivery<SlackChannelState>];
    expect(JSON.stringify("message" in input ? input.message : "")).toContain(
      "id: U01\\nreal_name: cached-U01\\nemail: alice@example.com\\n</sender>",
    );
    expect(fetchMock.mock.calls.map(([request]) => String(request))).not.toContainEqual(
      expect.stringContaining("users.info"),
    );
  });

  it("looks up no profiles when the option is off", async () => {
    const channel = slackChannel({
      credentials: { botToken: "xoxb-test" },
      onAppMention: () => ({ auth: null }),
    });

    await firePost(channel, mention({ ts: "1700000000.000001" }));

    expect(fetchMock.mock.calls.map(([request]) => String(request))).not.toContainEqual(
      expect.stringContaining("users.info"),
    );
  });
});

describe("slackChannel thread history", () => {
  it("adds earlier replies as history when a mention starts the thread's session", async () => {
    const threadTs = "1700000000.000001";
    const currentTs = "1700000000.000004";
    fetchMock.mockImplementation(async (request: string | URL | Request) => {
      const url = String(request);
      if (url.includes("conversations.replies"))
        return Response.json({
          messages: [
            { text: "Daily report?", thread_ts: threadTs, ts: threadTs, user: "U_ROOT" },
            {
              app_id: "A01",
              bot_id: "B_AGENT",
              text: "Deploys are green.",
              thread_ts: threadTs,
              ts: "1700000000.000002",
              user: "U_BOT",
            },
            { text: "Thanks!", thread_ts: threadTs, ts: "1700000000.000003", user: "U_OTHER" },
            { text: "Any flakes?", thread_ts: threadTs, ts: currentTs, user: "U_CURRENT" },
          ],
          ok: true,
        });
      if (url.includes("conversations.info"))
        return Response.json({ channel: { is_private: false }, ok: true });
      return Response.json({ ok: true, ts: "1700000001.000001" });
    });
    const channel = slackChannel({
      credentials: { botToken: "xoxb-test" },
      onAppMention: () => ({ auth: null }),
      threadContext: {},
    });
    const event = {
      channel: "C01",
      event_ts: currentTs,
      text: "Any flakes?",
      thread_ts: threadTs,
      ts: currentTs,
      type: "app_mention",
      user: "U_CURRENT",
    };
    const send = vi.fn().mockResolvedValue({ sessionId: "s1" });
    await firePost(
      channel,
      signed(
        JSON.stringify({
          api_app_id: "A01",
          authorizations: [{ is_bot: true, user_id: "U_BOT" }],
          event,
          event_id: "EvHistory",
          team_id: "T01",
          type: "event_callback",
        }),
      ),
      send,
      async () => undefined,
    );

    const [, input] = send.mock.calls[0]! as [string, ObservedChannelDelivery<SlackChannelState>];
    expect(JSON.stringify("message" in input ? input.message : "")).not.toContain(
      "<slack_thread_context>",
    );
    const history = "history" in input ? input.history : undefined;
    expect(history?.map(({ id, role }) => ({ id, role }))).toEqual([
      { id: threadTs, role: "user" },
      { id: "1700000000.000002", role: "assistant" },
      { id: "1700000000.000003", role: "user" },
    ]);
    expect(history?.[0]?.text).toContain("id: U_ROOT");
    expect(history?.[1]?.text).toBe("Deploys are green.");
  });

  it("passes every send option from a generic event's send", async () => {
    const channel = slackChannel({
      credentials: { botToken: "xoxb-test" },
      async onEvent(ctx) {
        await ctx.send("follow up", {
          auth: null,
          context: ["Alice reacted with :eyes:."],
          history: [{ role: "user", text: "Earlier question" }],
          idempotencyKey: "slack:EvReaction",
          outputSchema: { type: "object" },
          target: { channelId: "C01", threadTs: "1700000000.000001" },
          title: "Reaction follow-up",
          turnPolicy: "queue",
        });
      },
    });
    const send = vi.fn().mockResolvedValue({ sessionId: "s1" });
    await firePost(
      channel,
      signed(
        JSON.stringify({
          event: { type: "reaction_added", user: "U01" },
          event_id: "EvReaction",
          team_id: "T01",
          type: "event_callback",
        }),
      ),
      send,
    );

    expect(send).toHaveBeenCalledWith(
      "C01:1700000000.000001",
      expect.objectContaining({
        context: ["Alice reacted with :eyes:."],
        history: [{ role: "user", text: "Earlier question" }],
        idempotencyKey: "slack:EvReaction",
        outputSchema: { type: "object" },
        title: "Reaction follow-up",
        turnPolicy: "queue",
      }),
    );
  });

  it.each<{ message: SlackPostInput; expected: Record<string, unknown> }>([
    { message: { markdown: "*Alice's update*" }, expected: { markdown_text: "*Alice's update*" } },
    { message: { text: "Alice's update" }, expected: { text: "Alice's update" } },
    {
      message: {
        text: "Alice's report",
        files: [{ data: Buffer.from("report"), filename: "report.txt" }],
      },
      expected: { text: "Alice's report" },
    },
    {
      message: { blocks: [{ type: "divider" }], text: "Update" },
      expected: { blocks: [{ type: "divider" }], text: "Update" },
    },
    {
      message: { card: Card({ children: [CardText("Update")] }), fallbackText: "Notification" },
      expected: {
        blocks: [{ type: "section", text: { type: "mrkdwn", text: "Update" } }],
        text: "Notification",
      },
    },
  ])(
    "posts an initial $message message and routes the turn under its root",
    async ({ message, expected }) => {
      const channel = slackChannel({
        credentials: { botToken: "xoxb-test" },
        async onEvent(ctx) {
          await ctx.send("follow up", {
            auth: null,
            target: { channelId: "C01", initialMessage: message },
          });
        },
      });
      const send = vi.fn().mockResolvedValue({ sessionId: "s1" });
      await firePost(
        channel,
        signed(
          JSON.stringify({
            event: { type: "reaction_added", user: "U01" },
            event_id: "EvInitial",
            team_id: "T01",
            type: "event_callback",
          }),
        ),
        send,
      );
      expect(slackCalls("chat.postMessage")).toEqual([
        expect.objectContaining({ channel: "C01", ...expected }),
      ]);
      expect(slackCalls("chat.postMessage")[0]).not.toHaveProperty("thread_ts");
      expect(send).toHaveBeenCalledWith("C01:1700000001.000001", expect.anything());
      if (message.files?.length) {
        expect(slackCalls("files.completeUploadExternal")).toEqual([
          expect.objectContaining({ channel_id: "C01", thread_ts: "1700000001.000001" }),
        ]);
        expect(
          fetchMock.mock.calls.findIndex(([url]) => String(url).endsWith("chat.postMessage")),
        ).toBeLessThan(
          fetchMock.mock.calls.findIndex(([url]) =>
            String(url).endsWith("files.getUploadURLExternal"),
          ),
        );
      }
    },
  );

  it("rejects a generic event send's invalid key before posting its initial message", async () => {
    let sendError: unknown;
    const channel = slackChannel({
      credentials: { botToken: "xoxb-test" },
      async onEvent(ctx) {
        sendError = await ctx
          .send("follow up", {
            auth: null,
            idempotencyKey: "",
            target: {
              channelId: "C01",
              initialMessage: { card: Card({ children: [CardText("Alice reacted.")] }) },
            },
          })
          .catch((error: unknown) => error);
      },
    });
    const send = vi.fn().mockResolvedValue({ sessionId: "s1" });
    await firePost(
      channel,
      signed(
        JSON.stringify({
          event: { type: "reaction_added", user: "U01" },
          event_id: "EvReaction",
          team_id: "T01",
          type: "event_callback",
        }),
      ),
      send,
    );

    expect(sendError).toEqual(
      expect.objectContaining({ message: expect.stringContaining("idempotencyKey") }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("slackChannel message status and guidance", () => {
  const guidance = "This reply doesn't mention you. Answer only if it's meant for you.";

  function channelMessage(input: { readonly ts: string; readonly threadTs?: string }): Request {
    return signed(
      JSON.stringify({
        api_app_id: "A01",
        authorizations: [{ is_bot: true, user_id: "U_BOT" }],
        event: {
          channel: "C01",
          channel_type: "channel",
          text: "Alice, I can take the rollback.",
          ...(input.threadTs !== undefined && { thread_ts: input.threadTs }),
          ts: input.ts,
          type: "message",
          user: "U_BOB",
        },
        event_id: `Ev${input.ts}`,
        team_id: "T01",
        type: "event_callback",
      }),
    );
  }
  const rootTs = "1700000000.000001";
  const threadReply = () => channelMessage({ ts: "1700000000.000003", threadTs: rootTs });

  it("follows served threads with the documented onMessage hook", async () => {
    const followGuidance =
      "You are part of this Slack thread, so you see replies people send each other. This " +
      "reply doesn't mention you. Answer only if it's meant for you; otherwise call `no_reply`.";
    const channel = slackChannel({
      credentials: { botToken: "xoxb-test" },
      async onMessage(ctx, message) {
        if (message.author?.isBot !== false) return null;
        const auth = defaultSlackAuth(message, ctx);
        const isDirectMessage = message.raw.channel_type === "im";
        if (ctx.isBotMentioned() || ctx.slack.codeChannel || isDirectMessage) return { auth };
        if (ctx.edit || (message.threadTs !== message.ts && (await ctx.isSubscribed()))) {
          return { auth, status: "deferred", guidance: followGuidance };
        }
        return null;
      },
    });
    const send = vi.fn().mockResolvedValue({ sessionId: "s1" });
    const noSession = async () => undefined;

    await firePost(channel, threadReply(), send);
    await firePost(channel, channelMessage({ ts: "1700000000.000005" }), send);
    await firePost(
      channel,
      channelMessage({ ts: "1700000000.000007", threadTs: "1700000000.000006" }),
      send,
      noSession,
    );
    // An unmentioned edit to the root of the thread the agent serves.
    const root = {
      text: "Who can take the rollback?",
      thread_ts: rootTs,
      ts: rootTs,
      user: "U_BOB",
    };
    await firePost(
      channel,
      signed(
        JSON.stringify({
          api_app_id: "A01",
          authorizations: [{ is_bot: true, user_id: "U_BOT" }],
          event: {
            channel: "C01",
            channel_type: "channel",
            message: { ...root, text: "Who can take the rollback today?", edited: { ts: "1.9" } },
            previous_message: root,
            subtype: "message_changed",
            ts: "1700000000.000009",
            type: "message",
          },
          event_id: "EvRootEdit",
          team_id: "T01",
          type: "event_callback",
        }),
      ),
      send,
    );

    const deliveries = send.mock.calls as [string, ObservedChannelDelivery<SlackChannelState>][];
    expect(deliveries.map(([address]) => address)).toEqual([`C01:${rootTs}`, `C01:${rootTs}`]);
    for (const [, input] of deliveries) {
      expect(input.auth?.principalId).toBe("slack:T01:U_BOB");
      expect("message" in input && input.message).toEqual(
        expect.stringContaining(`<guidance>\n${followGuidance}\n</guidance>`),
      );
    }
    expect("message" in deliveries[1]![1] && deliveries[1]![1].message).toEqual(
      expect.stringContaining("<slack_message_edit>"),
    );
    expect(slackCalls("assistant.threads.setStatus")).toEqual([]);
  });

  // Each step is followed by the thread statuses it set. Mentions are acknowledged before their
  // hook runs, so `deferred` can only keep the rest of the turn quiet. A `hidden` tool sets
  // `label: false`: it shows no status and doesn't end a deferred turn's quiet.
  it.each<{
    name: string;
    request: () => Request;
    status: "immediate" | "deferred";
    steps?: readonly SlackTurnStep[];
    trace: string;
  }>([
    {
      name: "deferred reply",
      request: threadReply,
      status: "deferred",
      trace: "post turn model tool model:Thinking...",
    },
    {
      name: "immediate reply",
      request: threadReply,
      status: "immediate",
      trace:
        "post:Thinking... turn:Thinking... model:Thinking... tool:Get weather model:Get weather",
    },
    {
      name: "deferred mention",
      request: () => mention({ ts: "1700000000.000004", threadTs: "1700000000.000001" }),
      status: "deferred",
      trace: "post:Thinking... turn model tool model:Thinking...",
    },
    {
      name: "deferred reply with a hidden tool",
      request: threadReply,
      status: "deferred",
      steps: ["turn", "model", "hidden", "model", "no_reply", "end"],
      trace: "post turn model hidden model no_reply end:",
    },
    {
      name: "deferred reply with a hidden tool, then a real one",
      request: threadReply,
      status: "deferred",
      steps: ["turn", "model", "hidden", "model", "tool", "model"],
      trace: "post turn model hidden model tool model:Thinking...",
    },
    {
      name: "immediate reply with a hidden tool",
      request: threadReply,
      status: "immediate",
      steps: ["turn", "model", "hidden", "model"],
      trace: "post:Thinking... turn:Thinking... model:Thinking... hidden model:Thinking...",
    },
  ])("$name", async ({ request, status, steps = ["turn", "model", "tool", "model"], trace }) => {
    const edits: unknown[] = [];
    const channel = slackChannel({
      credentials: { botToken: "xoxb-test" },
      onMessage: (ctx) => {
        edits.push(ctx.edit);
        return { auth: null, guidance, status };
      },
    });
    const send = vi.fn().mockResolvedValue({ sessionId: "s1" });
    const statuses = () =>
      slackCalls("assistant.threads.setStatus").map(({ status }) => String(status));

    await firePost(channel, request(), send);
    const observed = [["post", ...statuses()].join(":")];
    const [, input] = send.mock.calls[0]! as [string, ObservedChannelDelivery<SlackChannelState>];
    const harness = slackRenderingHarness(channel, {
      channelId: "C01",
      teamId: "T01",
      threadTs: "1700000000.000001",
    });
    await harness.deliver(input);
    for (const step of steps) {
      const before = statuses().length;
      await harness.step(step);
      observed.push([step, ...statuses().slice(before)].join(":"));
    }

    expect(observed.join(" ")).toBe(trace);
    expect(edits).toEqual([undefined]);
    expect("message" in input && input.message).toEqual(
      expect.stringContaining(`<guidance>\n${guidance}\n</guidance>`),
    );
  });
});

describe("slackChannel message edits", () => {
  const rootTs = "1700000000.000001";

  function edited(input: {
    readonly channelType?: "channel" | "im";
    readonly previousText?: string;
    readonly text: string;
  }): Request {
    const message = { text: input.text, thread_ts: rootTs, ts: "1700000000.000002", user: "U01" };
    return signed(
      JSON.stringify({
        api_app_id: "A01",
        authorizations: [{ is_bot: true, user_id: "U_BOT" }],
        event: {
          channel: "C01",
          channel_type: input.channelType ?? "channel",
          message: { ...message, edited: { ts: "1700000000.000009", user: "U01" } },
          ...(input.previousText !== undefined && {
            previous_message: { ...message, text: input.previousText },
          }),
          subtype: "message_changed",
          ts: "1700000000.000009",
          type: "message",
        },
        event_id: `EvEdit:${input.text}`,
        team_id: "T01",
        type: "event_callback",
      }),
    );
  }

  it("sends an edited mention to the thread's session as a diff, showing no status", async () => {
    const send = vi.fn().mockResolvedValue({ sessionId: "s1" });

    await firePost(
      slackChannel({ credentials: { botToken: "xoxb-test" } }),
      edited({ previousText: "<@U_BOT> weather in Pari?", text: "<@U_BOT> weather in Paris?" }),
      send,
    );

    expect(send).toHaveBeenCalledTimes(1);
    const [address, input] = send.mock.calls[0]! as [
      string,
      ObservedChannelDelivery<SlackChannelState>,
    ];
    expect(address).toBe(`C01:${rootTs}`);
    expect(input).toMatchObject({ state: { quiet: true } });
    // The channel's `turnPolicy` applies, so a queued edit can't overtake the message it edits.
    expect(input).not.toHaveProperty("turnPolicy");
    expect(input).not.toHaveProperty("title");
    expect("message" in input && input.message).toEqual(
      expect.stringContaining(
        "<diff>\n-<@U_BOT> weather in Pari?\n+<@U_BOT> weather in Paris?\n</diff>",
      ),
    );
    expect(slackCalls("assistant.threads.setStatus")).toEqual([]);
  });

  it("ignores an edit in a thread without a session", async () => {
    const send = vi.fn();

    await firePost(
      slackChannel({ credentials: { botToken: "xoxb-test" } }),
      edited({ text: "<@U_BOT> weather in Paris?" }),
      send,
      async () => undefined,
    );

    expect(send).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drops an edit to a message not addressed to the agent unless onMessageEdited takes it", async () => {
    const request = () => edited({ previousText: "Lunch?", text: "Lunch at noon?" });
    const dropped = vi.fn();
    await firePost(slackChannel({ credentials: { botToken: "xoxb-test" } }), request(), dropped);
    expect(dropped).not.toHaveBeenCalled();

    const onMessageEdited = vi.fn<NonNullable<SlackChannelConfig["onMessageEdited"]>>(() => ({
      auth: null,
    }));
    const send = vi.fn().mockResolvedValue({ sessionId: "s1" });
    await firePost(
      slackChannel({ credentials: { botToken: "xoxb-test" }, onMessageEdited }),
      request(),
      send,
    );

    expect(onMessageEdited.mock.calls[0]?.[1]).toMatchObject({
      editedTs: "1700000000.000009",
      message: { text: "Lunch at noon?", ts: "1700000000.000002" },
      previousText: "Lunch?",
    });
    expect(send).toHaveBeenCalledWith(`C01:${rootTs}`, expect.anything());
  });

  it("sends an edit that removes the bot mention, which the model sees as unmentioned", async () => {
    const send = vi.fn().mockResolvedValue({ sessionId: "s1" });

    await firePost(
      slackChannel({ credentials: { botToken: "xoxb-test" } }),
      edited({ previousText: "<@U_BOT> can you review?", text: "<@U_ALICE> can you review?" }),
      send,
    );

    const [, input] = send.mock.calls[0]! as [string, ObservedChannelDelivery<SlackChannelState>];
    expect("message" in input && input.message).toEqual(
      expect.stringContaining("<bot>\nid: U_BOT\nmentioned: false\n</bot>"),
    );
  });

  type MessageHook = "onAppMention" | "onDirectMessage" | "onMessage" | "onMessageEdited";
  const allHooks: readonly MessageHook[] = ["onAppMention", "onDirectMessage", "onMessage"];
  const mentionEdit = { previousText: "<@U_BOT> hi", text: "<@U_BOT> hello" };
  const dmEdit = { channelType: "im", previousText: "hi", text: "hello" } as const;
  const otherEdit = { previousText: "Lunch?", text: "Lunch at noon?" };

  // Each row authors a hook the edit must skip, so the default can't just be "no hooks".
  it.each<{
    name: string;
    edit: Parameters<typeof edited>[0];
    hooks: readonly MessageHook[];
    reached: MessageHook | "default" | null;
  }>([
    {
      name: "mention edit to onAppMention",
      edit: mentionEdit,
      hooks: allHooks,
      reached: "onAppMention",
    },
    {
      name: "mention edit to onMessage",
      edit: mentionEdit,
      hooks: ["onDirectMessage", "onMessage"],
      reached: "onMessage",
    },
    {
      name: "mention edit to the default",
      edit: mentionEdit,
      hooks: ["onDirectMessage"],
      reached: "default",
    },
    {
      name: "DM edit to onDirectMessage",
      edit: dmEdit,
      hooks: allHooks,
      reached: "onDirectMessage",
    },
    {
      name: "DM edit to onMessage",
      edit: dmEdit,
      hooks: ["onAppMention", "onMessage"],
      reached: "onMessage",
    },
    { name: "DM edit to the default", edit: dmEdit, hooks: ["onAppMention"], reached: "default" },
    { name: "other edit to onMessage", edit: otherEdit, hooks: allHooks, reached: "onMessage" },
    {
      name: "other edit, ignored",
      edit: otherEdit,
      hooks: ["onAppMention", "onDirectMessage"],
      reached: null,
    },
    {
      name: "DM mention edit to onDirectMessage",
      edit: { ...dmEdit, previousText: "<@U_BOT> hi", text: "<@U_BOT> hello" },
      hooks: allHooks,
      reached: "onDirectMessage",
    },
    {
      name: "onMessageEdited before onMessage",
      edit: mentionEdit,
      hooks: ["onMessage", "onMessageEdited"],
      reached: "onMessageEdited",
    },
  ])("$name", async ({ edit, hooks, reached }) => {
    const calls: string[] = [];
    // Records the text each hook decided and the edit `ctx.edit` showed it.
    const hook = (name: MessageHook) =>
      name === "onMessageEdited"
        ? (ctx: SlackInboundMessageContext, decided: SlackMessageEdit) => {
            calls.push(`${name}: ${decided.message.text} @${ctx.edit?.editedTs}`);
            return { auth: null };
          }
        : (ctx: SlackInboundMessageContext, message: SlackMessage) => {
            calls.push(`${name}: ${message.text} @${ctx.edit?.editedTs}`);
            return { auth: null };
          };
    const send = vi.fn().mockResolvedValue({ sessionId: "s1" });

    await firePost(
      slackChannel({
        credentials: { botToken: "xoxb-test" },
        ...Object.fromEntries(hooks.map((name) => [name, hook(name)])),
      }),
      edited(edit),
      send,
    );

    expect(calls).toEqual(
      reached === null || reached === "default"
        ? []
        : [`${reached}: ${edit.text} @1700000000.000009`],
    );
    expect(send).toHaveBeenCalledTimes(reached === null ? 0 : 1);
    const auth = (send.mock.calls[0]?.[1] as ObservedChannelDelivery<SlackChannelState> | undefined)
      ?.auth;
    if (reached === "default") expect(auth?.principalId).toBe("slack:T01:U01");
  });

  it("sends an edit's guidance from onMessage, ignoring its status, and drops what it drops", async () => {
    const guidance = "This reply doesn't mention you. Answer only if it's meant for you.";
    const channel = slackChannel({
      credentials: { botToken: "xoxb-test" },
      onMessage: (_ctx, message) =>
        message.text.includes("rollback") ? { auth: null, guidance, status: "immediate" } : null,
    });
    const send = vi.fn().mockResolvedValue({ sessionId: "s1" });

    await firePost(channel, edited({ previousText: "Lunch?", text: "Lunch at noon?" }), send);
    await firePost(
      channel,
      edited({ previousText: "I can take it", text: "I can take the rollback" }),
      send,
    );

    expect(send).toHaveBeenCalledTimes(1);
    const [, input] = send.mock.calls[0]! as [string, ObservedChannelDelivery<SlackChannelState>];
    expect(input).toMatchObject({ state: { quiet: true } });
    expect("message" in input && input.message).toEqual(
      expect.stringContaining(`<slack_message_edit>`),
    );
    expect("message" in input && input.message).toEqual(
      expect.stringContaining(`<guidance>\n${guidance}\n</guidance>`),
    );
    expect(slackCalls("assistant.threads.setStatus")).toEqual([]);
  });

  it("leaves an edit to an authored onEvent before the hooks it would reach", async () => {
    const onAppMention = vi.fn(() => ({ auth: null }));
    const onMessage = vi.fn(() => ({ auth: null }));
    const onEvent = vi.fn();
    const send = vi.fn();

    await firePost(
      slackChannel({ credentials: { botToken: "xoxb-test" }, onAppMention, onEvent, onMessage }),
      edited({ previousText: "<@U_BOT> hi", text: "<@U_BOT> hello" }),
      send,
    );

    expect(onEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ subtype: "message_changed" }),
    );
    expect(onAppMention).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
