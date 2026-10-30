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
import { ANSWER_ACTION_PREFIX } from "#public/channels/slack/hitl.js";
import { defaultSlackAuth } from "#public/channels/slack/defaults.js";
import {
  slackChannel,
  type SlackChannelConfig,
  type SlackChannelState,
} from "#public/channels/slack/slackChannel.js";

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

describe("slackChannel onSlashCommand", () => {
  it("starts a thread for the user who ran the command", async () => {
    const send = vi.fn().mockResolvedValue({ sessionId: "s1" });
    await firePost(
      slackChannel({
        credentials: { botToken: "xoxb-test" },
        async onSlashCommand(command, ctx) {
          await ctx.send(`Write a standup about ${command.text}.`, {
            auth: ctx.defaultAuth,
            target: {
              channelId: command.channelId,
              initialMessage: { text: `<@${command.user.id}> asked for a standup` },
            },
          });
        },
      }),
      signed(
        new URLSearchParams({
          channel_id: "C01",
          channel_name: "general",
          command: "/standup",
          response_url: "https://hooks.slack.com/commands/T01/1/abc",
          team_id: "T01",
          text: "the release",
          trigger_id: "trigger-1",
          user_id: "U01",
          user_name: "alice",
        }).toString(),
        "application/x-www-form-urlencoded",
      ),
      send,
    );

    expect(slackCalls("chat.postMessage")[0]).toMatchObject({
      channel: "C01",
      text: "<@U01> asked for a standup",
    });
    const [, input] = send.mock.calls[0]! as [string, ObservedChannelDelivery<SlackChannelState>];
    expect(input).toMatchObject({
      auth: { principalId: "slack:T01:U01" },
      message: "Write a standup about the release.",
      state: { channelId: "C01", threadTs: "1700000001.000001", triggeringUserId: "U01" },
    });
  });
});

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
