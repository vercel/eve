import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isCompiledChannel } from "#channel/compiled-channel.js";
import { isHttpRouteDefinition } from "#channel/routes.js";
import { SessionStrandedError } from "#channel/session-stranded-error.js";
import {
  mockChannelContext,
  type ObservedChannelDelivery,
} from "#internal/testing/mocks/mock-channel-operations.js";
import { mockAgentRouteArgs } from "#internal/testing/mocks/mock-route-args.js";
import { decodeSlackApiBody } from "#internal/testing/slack-api-body.js";
import { ANSWER_ACTION_PREFIX } from "#public/channels/slack/hitl.js";
import { slackChannel, type SlackChannelState } from "#public/channels/slack/slackChannel.js";

const SIGNING_SECRET = "test-signing-secret";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv("SLACK_SIGNING_SECRET", SIGNING_SECRET);
  fetchMock = vi.fn(async (request: string | URL | Request) =>
    String(request).includes("conversations.info")
      ? Response.json({ channel: { is_private: false }, ok: true })
      : Response.json({ ok: true, ts: "1700000001.000001" }),
  );
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
    resolveSession: () => Promise.resolve({ id: "s1" }) as never,
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
