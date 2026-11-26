import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isCompiledChannel } from "#channel/compiled-channel.js";
import { isHttpRouteDefinition } from "#channel/routes.js";
import { mockChannelContext } from "#internal/testing/mocks/mock-channel-operations.js";
import { mockAgentRouteArgs } from "#internal/testing/mocks/mock-route-args.js";
import { SLACK_EVENT_SCOPES } from "#public/channels/slack/event-scopes.js";
import { slackChannel } from "#public/channels/slack/slackChannel.js";
import {
  describeSlackEvent,
  parseSlackEventOccurrence,
  slackEventDefinitions,
} from "#public/channels/slack/subscriptions.js";
import type {
  ChannelEvent,
  ChannelEventDefinition,
  ChannelOnEvent,
  ChannelOnSubscribe,
  EmitChannelEventFn,
} from "#shared/channel-subscriptions.js";
import { serializeInputSchema } from "#tools/schema.js";
import { checkEventInput } from "#runtime/subscriptions/event-definitions.js";

const SECRET = "slack-secret";
const BOT_USER = "UBOT";
const APP_ID = "A1";
const SEND_ALL: ChannelOnEvent = ({ event }) => describeSlackEvent(event);

function definition(name: string): ChannelEventDefinition {
  const found = slackEventDefinitions([name])[0];
  if (found === undefined) throw new Error(`no definition for ${name}`);
  return found;
}

function jsonSchemaOf(event: ChannelEventDefinition): { properties: Record<string, unknown> } {
  return serializeInputSchema(event.inputSchema) as { properties: Record<string, unknown> };
}

function envelope(event: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    api_app_id: APP_ID,
    authorizations: [{ is_bot: true, team_id: "T1", user_id: BOT_USER }],
    event,
    event_id: "Ev1",
    team_id: "T1",
    type: "event_callback",
    ...extra,
  };
}

function signed(body: string): Request {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = `v0=${createHmac("sha256", SECRET).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return new Request("https://example.com/eve/v1/slack", {
    body,
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": String(timestamp),
      "x-slack-signature": signature,
    },
    method: "POST",
  });
}

async function post(input: {
  readonly body: Record<string, unknown>;
  readonly onEvent?: ChannelOnEvent | null;
  readonly events?: readonly (keyof typeof SLACK_EVENT_SCOPES)[];
  readonly emitError?: Error;
  readonly onMessage?: () => void;
}): Promise<{ response: Response; emit: ReturnType<typeof vi.fn<EmitChannelEventFn>> }> {
  const channel = slackChannel({
    credentials: { botToken: "xoxb-test", signingSecret: SECRET },
    experimental:
      input.onEvent === null
        ? undefined
        : { subscriptions: { onEvent: input.onEvent ?? SEND_ALL, events: input.events } },
    onMessage: input.onMessage as never,
  });
  if (!isCompiledChannel(channel)) throw new Error("Expected a CompiledChannel.");
  const route = channel.routes.find((candidate) => candidate.method === "POST");
  if (!route || !isHttpRouteDefinition(route)) throw new Error("Expected a POST route.");
  const emit = vi.fn<EmitChannelEventFn>().mockResolvedValue(true);
  if (input.emitError !== undefined) emit.mockRejectedValue(input.emitError);
  const waitUntil = vi.fn();
  const response = await route.handler(signed(JSON.stringify(input.body)), {
    ...mockAgentRouteArgs(),
    attachSession: vi.fn() as never,
    ...mockChannelContext(vi.fn().mockResolvedValue({ id: "s1" })),
    experimental: { subscriptions: { emit } },
    params: {},
    requestIp: null,
    to: vi.fn() as never,
    waitUntil,
  });
  await Promise.all(waitUntil.mock.calls.map(([task]) => task as Promise<unknown>));
  return { response, emit };
}

const scopesOf = (emit: ReturnType<typeof vi.fn<EmitChannelEventFn>>) =>
  emit.mock.calls.map(([name, scope]) => [name, scope]);

const reaction = {
  item: { channel: "C1", ts: "1.1", type: "message" },
  reaction: "eyes",
  type: "reaction_added",
  user: "U1",
};

beforeEach(() => {
  vi.stubEnv("SLACK_SIGNING_SECRET", SECRET);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ ok: true })),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Slack channel subscriptions", () => {
  describe("slackEventDefinitions", () => {
    it("defaults to the five events the app manifest subscribes to", () => {
      expect(slackEventDefinitions().map((event) => event.name)).toEqual([
        "app_mention",
        "message.channels",
        "message.groups",
        "message.im",
        "message.mpim",
      ]);
    });

    it("offers a workspace event only team_id, and a channel event team_id, channel and ts", () => {
      expect(Object.keys(jsonSchemaOf(definition("team_join")).properties)).toEqual(["team_id"]);
      expect(Object.keys(jsonSchemaOf(definition("channel_archive")).properties)).toEqual([
        "team_id",
        "channel",
      ]);
      expect(Object.keys(jsonSchemaOf(definition("reaction_added")).properties)).toEqual([
        "team_id",
        "channel",
        "ts",
      ]);
    });

    it("rejects ts without channel, an unknown field, and a missing team_id", async () => {
      const check = (name: string, input: Record<string, string>) =>
        checkEventInput(definition(name), input as never);
      await expect(
        check("reaction_added", { team_id: "T1", channel: "C1", ts: "1.1" }),
      ).resolves.toEqual({ team_id: "T1", channel: "C1", ts: "1.1" });
      await expect(check("reaction_added", { team_id: "T1", ts: "1.1" })).rejects.toThrow(
        "`ts` needs `channel`",
      );
      await expect(check("reaction_added", { team_id: "T1", team: "x" })).rejects.toThrow();
      await expect(check("reaction_added", { channel: "C1" })).rejects.toThrow();
      await expect(check("team_join", { team_id: "T1", channel: "C1" })).rejects.toThrow();
    });

    it("throws for an event Slack does not send, naming it", () => {
      expect(() => slackEventDefinitions(["reaction_added", "nope"])).toThrow('"nope"');
    });

    it("types events as the names the app manifest uses", () => {
      slackChannel({
        experimental: {
          subscriptions: { onEvent: SEND_ALL, events: ["reaction_added", "message.im"] },
        },
      });
      expect(() =>
        slackChannel({
          experimental: {
            // @ts-expect-error Slack has no `message` event in a manifest, only its four channel types.
            subscriptions: { onEvent: SEND_ALL, events: ["message"] },
          },
        }),
      ).toThrow('"message"');
    });
  });

  it("makes nothing subscribable and emits nothing without onEvent", async () => {
    const channel = slackChannel({ credentials: { botToken: "xoxb-test" } });
    if (!isCompiledChannel(channel)) throw new Error("Expected a CompiledChannel.");
    expect(channel.onEvent).toBeUndefined();
    const { response, emit } = await post({ body: envelope(reaction), onEvent: null });
    expect(response.status).toBe(200);
    expect(emit).not.toHaveBeenCalled();
  });

  describe("emitting", () => {
    it("emits a reaction for the workspace, the channel and the message it is on", async () => {
      const { response, emit } = await post({
        body: envelope(reaction),
        events: ["reaction_added"],
      });
      expect(response.status).toBe(200);
      expect(scopesOf(emit)).toEqual([
        ["reaction_added", { team_id: "T1" }],
        ["reaction_added", { team_id: "T1", channel: "C1" }],
        ["reaction_added", { team_id: "T1", channel: "C1", ts: "1.1" }],
      ]);
      expect(emit.mock.calls[0]![2]).toMatchObject({
        id: "Ev1",
        data: { team_id: "T1", channels: ["C1"], timestamps: ["1.1"], sender: "U1" },
      });
    });

    it("emits a threaded message for both the message and its thread", async () => {
      const { emit } = await post({
        body: envelope({
          channel: "C1",
          channel_type: "channel",
          text: "hi",
          thread_ts: "1.1",
          ts: "1.5",
          type: "message",
          user: "U1",
        }),
      });
      expect(scopesOf(emit)).toEqual([
        ["message.channels", { team_id: "T1" }],
        ["message.channels", { team_id: "T1", channel: "C1" }],
        ["message.channels", { team_id: "T1", channel: "C1", ts: "1.1" }],
        ["message.channels", { team_id: "T1", channel: "C1", ts: "1.5" }],
      ]);
    });

    it.each([
      ["channel", "message.channels"],
      ["group", "message.groups"],
      ["im", "message.im"],
      ["mpim", "message.mpim"],
    ])("names a %s message %s", async (channelType, name) => {
      const { emit } = await post({
        body: envelope({
          channel: "C1",
          channel_type: channelType,
          ts: "1.1",
          type: "message",
          user: "U1",
        }),
      });
      expect(new Set(emit.mock.calls.map(([event]) => event))).toEqual(new Set([name]));
    });

    it("emits an event with no channel for the workspace only", async () => {
      const { emit } = await post({
        body: envelope({ type: "team_join", user: { id: "U2" } }),
        events: ["team_join"],
      });
      expect(scopesOf(emit)).toEqual([["team_join", { team_id: "T1" }]]);
    });

    it("emits a file shared into one channel for that channel, and a list of channels for each", async () => {
      const { emit } = await post({
        body: envelope({ channel_id: "C1", file_id: "F1", type: "file_shared", user_id: "U1" }),
        events: ["file_shared"],
      });
      expect(scopesOf(emit)).toEqual([
        ["file_shared", { team_id: "T1" }],
        ["file_shared", { team_id: "T1", channel: "C1" }],
      ]);
      const deleted = await post({
        body: envelope({ channel_ids: ["C1", "C2"], file_id: "F1", type: "file_deleted" }),
        events: ["file_deleted"],
      });
      expect(deleted.emit).toHaveBeenCalledTimes(3);
    });

    it("takes the team from the installation when the envelope has none", async () => {
      const { emit } = await post({
        body: { ...envelope(reaction), team_id: undefined },
        events: ["reaction_added"],
      });
      expect(emit.mock.calls[0]![1]).toEqual({ team_id: "T1" });
    });

    it("emits nothing for an event the channel does not declare or Slack does not list", async () => {
      expect((await post({ body: envelope(reaction) })).emit).not.toHaveBeenCalled();
      expect(
        (await post({ body: envelope({ type: "brand_new_event" }), events: ["reaction_added"] }))
          .emit,
      ).not.toHaveBeenCalled();
    });

    it("skips what the bot wrote itself, by user, app id or bot profile", async () => {
      for (const own of [
        { ...reaction, user: BOT_USER },
        { ...reaction, app_id: APP_ID },
        { ...reaction, bot_profile: { app_id: APP_ID } },
      ]) {
        const { emit } = await post({ body: envelope(own), events: ["reaction_added"] });
        expect(emit).not.toHaveBeenCalled();
      }
      const other = await post({
        body: envelope({ ...reaction, bot_profile: { app_id: "A2" } }),
        events: ["reaction_added"],
      });
      expect(other.emit).toHaveBeenCalled();
    });

    it("answers 503 when the subscription handoff fails, so Slack retries, and still queues the message handler", async () => {
      const onMessage = vi.fn();
      const { response } = await post({
        body: envelope({
          channel: "C1",
          channel_type: "channel",
          text: "hi",
          ts: "1.1",
          type: "message",
          user: "U1",
        }),
        emitError: new Error("store down"),
        onMessage,
      });
      expect(response.status).toBe(503);
      expect(onMessage).toHaveBeenCalledTimes(1);
    });

    it("skips an edit or delete of a message the bot wrote, which Slack sends with no top-level user", async () => {
      const own = { channel: "C1", channel_type: "channel", ts: "1.1", user: BOT_USER };
      for (const event of [
        {
          channel: "C1",
          channel_type: "channel",
          type: "message",
          subtype: "message_changed",
          message: own,
          previous_message: own,
        },
        {
          channel: "C1",
          channel_type: "channel",
          type: "message",
          subtype: "message_changed",
          message: { ...own, user: "U1", app_id: APP_ID },
        },
        {
          channel: "C1",
          channel_type: "channel",
          type: "message",
          subtype: "message_changed",
          message: { ...own, user: undefined, bot_profile: { app_id: APP_ID } },
        },
        {
          channel: "C1",
          channel_type: "channel",
          type: "message",
          subtype: "message_deleted",
          deleted_ts: "1.1",
          previous_message: own,
        },
      ]) {
        const { emit } = await post({ body: envelope(event) });
        expect(emit).not.toHaveBeenCalled();
      }
      const human = { ...own, user: "U1" };
      const { emit } = await post({
        body: envelope({
          channel: "C1",
          channel_type: "channel",
          type: "message",
          subtype: "message_changed",
          message: human,
          previous_message: human,
        }),
      });
      expect(emit).toHaveBeenCalled();
    });

    it("names a deleted message by deleted_ts and the thread it was in", async () => {
      const { emit } = await post({
        body: envelope({
          channel: "C1",
          channel_type: "channel",
          deleted_ts: "1.5",
          previous_message: { thread_ts: "1.1", ts: "1.5", user: "U1" },
          subtype: "message_deleted",
          ts: "2.2",
          type: "message",
        }),
      });
      const messageScopes = scopesOf(emit).map(([, scope]) => scope);
      expect(messageScopes).toContainEqual({ team_id: "T1", channel: "C1", ts: "1.5" });
      expect(messageScopes).toContainEqual({ team_id: "T1", channel: "C1", ts: "1.1" });
    });

    it("emits a message and answers 200 for a channel with no message handler", async () => {
      expect(
        (await post({ body: envelope(reaction), events: ["reaction_added"] })).response.status,
      ).toBe(200);
      const { emit, response } = await post({
        body: envelope({
          channel: "C1",
          channel_type: "channel",
          text: "hi",
          ts: "1.1",
          type: "message",
          user: "U1",
        }),
      });
      expect(response.status).toBe(200);
      expect(emit).toHaveBeenCalled();
    });
  });

  describe("event payload credentials", () => {
    it("drops every action_token before an event reaches a subscriber's model input", () => {
      const occurrence = parseSlackEventOccurrence(
        envelope({
          action_token: "xoxe-top",
          assistant_thread: { action_token: "xoxe-assistant", context: {} },
          channel: "C1",
          channel_type: "channel",
          event_ts: "1.2",
          message: { action_token: "xoxe-nested", text: "hi", ts: "1.1" },
          text: "hello",
          ts: "1.1",
          type: "message",
          user: "U2",
        }) as never,
      );
      expect(occurrence).not.toBeNull();
      const payload = JSON.stringify(occurrence?.data.payload);
      expect(payload).not.toContain("action_token");
      expect(payload).not.toContain("xoxe-");
      expect(payload).toContain('"text":"hello"');
    });
  });

  describe("describeSlackEvent", () => {
    const event = (data: Record<string, unknown>): ChannelEvent => ({
      data: data as ChannelEvent["data"],
      id: "Ev1",
      name: "reaction_added",
    });

    it("names the workspace, channel, message and sender, and marks the payload untrusted", () => {
      const text = describeSlackEvent(
        event({
          channels: ["C1"],
          payload: { type: "reaction_added" },
          sender: "U1",
          team_id: "T1",
          timestamps: ["1.1"],
        }),
      );
      expect(text).toContain(
        "Slack event reaction_added in workspace T1 in channel C1 on message 1.1, sent by U1.",
      );
      expect(text).toContain("untrusted external data");
      expect(text).toContain('{"type":"reaction_added"}');
    });

    it("says when there is no sender, channel or message", () => {
      expect(describeSlackEvent(event({ payload: {}, sender: null, team_id: "T1" }))).toContain(
        "in workspace T1, with no sender.",
      );
    });

    it("clips a payload past 8000 characters", () => {
      const text = describeSlackEvent(
        event({ payload: { text: "x".repeat(9000) }, sender: null, team_id: "T1" }),
      );
      expect(text.endsWith("\n[payload cut]")).toBe(true);
      expect(text.length).toBeLessThan(8400);
    });
  });

  describe("subscribing", () => {
    const REQUEST: { channelName: string; event: string; input: Record<string, string> } = {
      channelName: "slack",
      event: "reaction_added",
      input: { team_id: "T1", channel: "C1" },
    };

    function subscribeTo(input: {
      readonly auth?: Response;
      readonly info?: Response;
      readonly onSubscribe?: ChannelOnSubscribe;
      readonly request?: typeof REQUEST;
      readonly botToken?: string | (() => never);
    }) {
      const fetchMock = vi.fn<typeof fetch>(async (url) =>
        String(url).includes("auth.test")
          ? (input.auth?.clone() ??
            Response.json(
              { ok: true, team_id: "T1" },
              { headers: { "x-oauth-scopes": "chat:write,reactions:read,channels:read" } },
            ))
          : (input.info?.clone() ??
            Response.json({ channel: { id: "C1", is_member: true }, ok: true })),
      );
      const channel = slackChannel({
        api: { fetch: fetchMock },
        credentials: { botToken: input.botToken ?? "xoxb-test" },
        experimental: { subscriptions: { onEvent: SEND_ALL, onSubscribe: input.onSubscribe } },
      });
      if (!isCompiledChannel(channel) || channel.onSubscribe === undefined)
        throw new Error("Expected a CompiledChannel with onSubscribe.");
      const request = input.request ?? REQUEST;
      return {
        fetchMock,
        subscribe: () =>
          channel.onSubscribe!({ auth: null, sessionId: "s1", subscription: request }),
      };
    }

    it("accepts a token of the workspace that has the event's scope, in a channel the bot is in", async () => {
      const { fetchMock, subscribe } = subscribeTo({});
      await expect(subscribe()).resolves.toBeUndefined();
      expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
        "https://slack.com/api/auth.test",
        "https://slack.com/api/conversations.info",
      ]);
      expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).get("authorization")).toBe(
        "Bearer xoxb-test",
      );
    });

    it("passes the workspace to a bot token function", async () => {
      const botToken = vi.fn(() => "xoxb-team");
      await subscribeTo({ botToken: botToken as never }).subscribe();
      expect(botToken).toHaveBeenCalledWith({ teamId: "T1" });
    });

    it("rejects a token that belongs to another workspace", async () => {
      const { subscribe } = subscribeTo({ auth: Response.json({ ok: true, team_id: "T2" }) });
      await expect(subscribe()).rejects.toThrow("belongs to workspace T2, not T1");
    });

    it("rejects an app with no scope for the event, naming the scope and the reinstall", async () => {
      const { subscribe } = subscribeTo({
        auth: Response.json(
          { ok: true, team_id: "T1" },
          { headers: { "x-oauth-scopes": "chat:write" } },
        ),
      });
      await expect(subscribe()).rejects.toThrow("`reactions:read`");
      await expect(subscribe()).rejects.toThrow("reinstall");
    });

    it("accepts any one of the scopes an event lists", async () => {
      const { subscribe } = subscribeTo({
        auth: Response.json(
          { ok: true, team_id: "T1" },
          { headers: { "x-oauth-scopes": "groups:read" } },
        ),
        request: { ...REQUEST, event: "member_joined_channel" },
      });
      await expect(subscribe()).resolves.toBeUndefined();
    });

    it("needs no scope for an event that lists none", async () => {
      const { subscribe } = subscribeTo({
        request: { ...REQUEST, event: "app_home_opened", input: { team_id: "T1" } },
        auth: Response.json({ ok: true, team_id: "T1" }),
      });
      await expect(subscribe()).resolves.toBeUndefined();
    });

    it("rejects with Slack's own error when auth.test or conversations.info fails", async () => {
      await expect(
        subscribeTo({ auth: Response.json({ ok: false, error: "invalid_auth" }) }).subscribe(),
      ).rejects.toThrow("auth.test with invalid_auth");
      await expect(
        subscribeTo({ info: Response.json({ ok: false, error: "channel_not_found" }) }).subscribe(),
      ).rejects.toThrow("conversations.info with channel_not_found");
    });

    it("rejects a public channel the bot is not a member of, and asks for an invite", async () => {
      const { subscribe } = subscribeTo({
        info: Response.json({ channel: { id: "C1", is_member: false }, ok: true }),
      });
      await expect(subscribe()).rejects.toThrow("not a member of C1");
    });

    it("accepts a direct message, which has no is_member, and a private channel that answers", async () => {
      await expect(
        subscribeTo({
          info: Response.json({ channel: { id: "D1", is_im: true }, ok: true }),
          request: { ...REQUEST, input: { team_id: "T1", channel: "D1" } },
        }).subscribe(),
      ).resolves.toBeUndefined();
      await expect(
        subscribeTo({
          info: Response.json({ channel: { id: "G1", is_private: true }, ok: true }),
        }).subscribe(),
      ).resolves.toBeUndefined();
      await expect(
        subscribeTo({
          info: Response.json({
            channel: { id: "G1", is_private: true, is_member: false },
            ok: true,
          }),
        }).subscribe(),
      ).rejects.toThrow("not a member");
    });

    it("skips conversations.info for a workspace subscription", async () => {
      const { fetchMock, subscribe } = subscribeTo({
        request: { ...REQUEST, input: { team_id: "T1" } },
      });
      await subscribe();
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it("runs the author's onSubscribe first, so a denied subscriber never reaches Slack, then checks the grant", async () => {
      const denied = subscribeTo({
        onSubscribe: vi.fn<ChannelOnSubscribe>().mockRejectedValue(new Error("not allowed")),
      });
      await expect(denied.subscribe()).rejects.toThrow("not allowed");
      expect(denied.fetchMock).not.toHaveBeenCalled();

      const grant = { input: { team_id: "T1" } };
      const narrowed = subscribeTo({
        onSubscribe: vi.fn<ChannelOnSubscribe>().mockResolvedValue(grant),
      });
      await expect(narrowed.subscribe()).resolves.toBe(grant);
      expect(narrowed.fetchMock).toHaveBeenCalledOnce();
    });

    it("says which workspace's token it could not get", async () => {
      const { subscribe } = subscribeTo({
        botToken: () => {
          throw new Error("no installation");
        },
      });
      await expect(subscribe()).rejects.toThrow("bot token for Slack workspace T1");
    });
  });
});
