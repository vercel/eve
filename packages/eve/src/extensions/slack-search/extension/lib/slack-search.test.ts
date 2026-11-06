import { describe, expect, it } from "vitest";

import { buildSlackAuthContext } from "#public/channels/slack/auth.js";

import { executeSearch } from "./search.js";
import { readSlackConversation, readSlackUser, type SlackRequest } from "./slack-api.js";
import { slackTurn, type SlackTurn } from "./turn.js";

type Calls = { operation: string; body: Record<string, unknown> }[];

function fakeSlack(responses: Record<string, Record<string, unknown>>): {
  calls: Calls;
  request: SlackRequest;
} {
  const calls: Calls = [];
  return {
    calls,
    request: async (operation, body) => {
      calls.push({ operation, body });
      return (responses[operation] ?? { ok: false, error: "unknown_method" }) as never;
    },
  };
}

function turnWith(request: SlackRequest, overrides: Partial<SlackTurn> = {}): SlackTurn {
  return {
    auth: null,
    actionToken: "action-1",
    request,
    authorize: async () => true,
    ...overrides,
  };
}

describe("slackTurn", () => {
  it("searches with the Slack message's action token and the installation workspace's bot token", async () => {
    const auth = buildSlackAuthContext({
      actionToken: "action-1",
      channelId: "C0CHANNEL1",
      installationTeamId: "T0INSTALL",
      teamId: "T0SENDER",
      userId: "U0ALICE",
    });
    const requests: { url: string; authorization: string | null; body: string }[] = [];
    const tokenTeams: (string | undefined)[] = [];
    const turn = slackTurn(auth, {
      botToken: ({ teamId }) => {
        tokenTeams.push(teamId);
        return "xoxb-install";
      },
      api: {
        fetch: async (input, init) => {
          requests.push({
            url: String(input),
            authorization: new Headers(init?.headers).get("authorization"),
            body: String(init?.body),
          });
          return Response.json({ ok: true, results: { messages: [] } });
        },
      },
    });

    await executeSearch({ query: "launch plan" }, turn);

    expect(tokenTeams).toEqual(["T0INSTALL"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://slack.com/api/assistant.search.context");
    expect(requests[0]!.authorization).toBe("Bearer xoxb-install");
    expect(Object.fromEntries(new URLSearchParams(requests[0]!.body))).toEqual({
      query: "launch plan",
      action_token: "action-1",
      channel_types: "public_channel",
    });
  });

  it("applies the access policy to the turn's caller", async () => {
    const auth = buildSlackAuthContext({ channelId: "C0CHANNEL1", userId: "U0ALICE" });
    const turn = slackTurn(auth, {
      authorize: ({ auth: caller, channelId }) =>
        caller?.principalId === "slack:U0ALICE" && channelId === "C0OPEN000",
    });

    expect(turn.actionToken).toBeUndefined();
    await expect(turn.authorize({ tool: "search", channelId: "C0OPEN000" })).resolves.toBe(true);
    await expect(turn.authorize({ tool: "search", channelId: "C0CLOSED0" })).resolves.toBe(false);
  });
});

describe("executeSearch", () => {
  it("scopes the query to one day and withholds matches the policy denies", async () => {
    const slack = fakeSlack({
      "assistant.search.context": {
        ok: true,
        results: {
          messages: [
            { channel_id: "C0OPEN000", content: "ship it", permalink: "https://x/p1" },
            { channel_id: "C0CLOSED0", content: "secret", permalink: "https://x/p2" },
          ],
        },
      },
    });
    const result = await executeSearch(
      { query: "launch on:2026-01-01 plan", onDate: "2026-11-05" },
      turnWith(slack.request, {
        authorize: async ({ channelId }) => channelId === "C0OPEN000",
      }),
    );

    expect(slack.calls[0]!.body.query).toBe("launch plan on:2026-11-05");
    expect(result).toMatchObject({
      matches: [{ channelId: "C0OPEN000", text: "ship it", permalink: "https://x/p1" }],
      withheld: 1,
    });
  });

  it("reports an expired action token as the end of search for the turn", async () => {
    const slack = fakeSlack({
      "assistant.search.context": { ok: false, error: "invalid_action_token" },
    });

    await expect(executeSearch({ query: "q" }, turnWith(slack.request))).resolves.toMatchObject({
      unavailable: true,
      reason: "search_token_expired",
    });
  });

  it("does not call Slack without an action token", async () => {
    const slack = fakeSlack({});

    await expect(
      executeSearch({ query: "q" }, turnWith(slack.request, { actionToken: undefined })),
    ).resolves.toMatchObject({ unavailable: true, reason: "no_slack_message" });
    expect(slack.calls).toEqual([]);
  });
});

describe("readSlackConversation", () => {
  const options = { workspace: "T0READ", authorize: async () => true };

  it.each([
    ["a private channel", { is_private: true }, options, "private_channel"],
    ["a channel the bot is not in", { is_member: false }, options, "not_in_channel"],
    [
      "a channel the policy denies",
      { is_member: true },
      { ...options, authorize: async () => false },
      "not_authorized",
    ],
  ])("refuses %s before reading messages", async (_name, channel, readOptions, reason) => {
    const slack = fakeSlack({
      "conversations.info": { ok: true, channel: { id: "C0CHANNEL1", ...channel } },
    });

    await expect(
      readSlackConversation(slack.request, { channel: "C0CHANNEL1" }, readOptions),
    ).resolves.toMatchObject({ unavailable: true, reason });
    expect(slack.calls.map((call) => call.operation)).toEqual(["conversations.info"]);
  });

  it("resolves a channel name and reads the thread a permalink points to", async () => {
    const slack = fakeSlack({
      "conversations.list": {
        ok: true,
        channels: [{ id: "C0LAUNCH1", name: "launch" }],
        response_metadata: { next_cursor: "" },
      },
      "conversations.info": {
        ok: true,
        channel: { id: "C0LAUNCH1", name: "launch", is_member: true },
      },
      "conversations.history": { ok: true, messages: [] },
      "conversations.replies": {
        ok: true,
        messages: [
          {
            ts: "1785412800.000100",
            user: "U0ALICE",
            text: "",
            attachments: [{ text: "forwarded decision" }],
          },
        ],
        has_more: true,
        response_metadata: { next_cursor: "page-2" },
      },
      "chat.getPermalink": { ok: true, permalink: "https://x/thread" },
    });

    const byName = await readSlackConversation(slack.request, { channel: "#Launch" }, options);
    expect(byName).toMatchObject({ channel: { id: "C0LAUNCH1" } });

    const thread = await readSlackConversation(
      slack.request,
      { channel: "https://acme.slack.com/archives/C0LAUNCH1/p1785412800000100" },
      options,
    );
    expect(thread).toMatchObject({
      source: "replies",
      threadTs: "1785412800.000100",
      permalink: "https://x/thread",
      nextCursor: "page-2",
      messages: [{ userId: "U0ALICE", text: "forwarded decision" }],
    });
  });

  it("rejects a time window that ends before it starts", async () => {
    const slack = fakeSlack({});

    await expect(
      readSlackConversation(
        slack.request,
        { channel: "C0CHANNEL1", oldest: "2026-02-01T00:00:00Z", latest: "2026-01-01T00:00:00Z" },
        options,
      ),
    ).rejects.toThrow(/not after the oldest bound/);
    expect(slack.calls).toEqual([]);
  });
});

describe("readSlackUser", () => {
  it("returns names and time zone without contact details", async () => {
    const slack = fakeSlack({
      "users.info": {
        ok: true,
        user: {
          id: "U0ALICE",
          name: "alice",
          tz: "America/New_York",
          profile: { real_name: "Alice Example", email: "alice@example.com", phone: "555" },
        },
      },
    });

    const user = await readSlackUser(slack.request, "<@u0alice>");

    expect(slack.calls[0]!.body).toEqual({ user: "U0ALICE" });
    expect(user).toMatchObject({
      id: "U0ALICE",
      realName: "Alice Example",
      timezone: "America/New_York",
    });
    expect(JSON.stringify(user)).not.toMatch(/example\.com|555/);
  });
});
