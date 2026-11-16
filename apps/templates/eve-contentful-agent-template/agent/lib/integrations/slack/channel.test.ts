import type {
  SlackChannelConfig,
  SlackHandle,
  SlackMessage,
  SlackThread,
} from "eve/channels/slack";
import type { SessionAuthContext } from "eve/context";
import { describe, expect, it, vi } from "vitest";

import { slackAuth } from "../../testing/session";
import { inboundContext, slackAuthor, slackMessage } from "../../testing/slack";
import {
  createSlackInboundHandlers,
  handleExplicitInvocation,
  selectInboundHandlers,
} from "./channel";

type Handler = NonNullable<SlackChannelConfig["onMessage"]>;

const THREAD_TS = "100.1";
const MESSAGE_TS = "100.2";
const userAuth = slackAuth({ channelId: "C123", threadTs: THREAD_TS });
const identityContext = expect.stringContaining("Slack identities for message");

const accepted = (auth: SessionAuthContext) => ({
  auth,
  context: [identityContext],
});

const context = (
  subscribed: boolean,
  participants: readonly string[] | Error = []
) => {
  const listParticipants = vi.fn<SlackThread["listParticipants"]>(() =>
    participants instanceof Error
      ? Promise.reject(participants)
      : Promise.resolve(participants)
  );
  const request = vi.fn<SlackHandle["request"]>(() =>
    Promise.resolve({
      ok: true,
      user: { profile: { display_name: "Resolved name" } },
    })
  );
  return inboundContext({
    slack: { request },
    subscribed,
    thread: { listParticipants },
  });
};

const message = (overrides: Partial<SlackMessage> = {}): SlackMessage =>
  slackMessage({ threadTs: THREAD_TS, ts: MESSAGE_TS, ...overrides });

const configuredChannel = (
  options: Parameters<typeof createSlackInboundHandlers>[0] = {}
) =>
  createSlackInboundHandlers({
    threadContext: { since: "thread-root" },
    ...options,
  });

const custom: Handler = () => null;

const workflowServiceAuth = {
  attributes: {
    author_type: "bot",
    channel_id: "C123",
    team_id: "T123",
    thread_ts: THREAD_TS,
    user_id: "UWORKFLOW",
  },
  authenticator: "slack-webhook",
  issuer: "slack:T123",
  principalId: "slack:T123:bot:UWORKFLOW",
  principalType: "service",
};

const workflowPostAuth = {
  attributes: {
    author_type: "bot",
    bot_id: "B0WORKFLOW",
    channel_id: "C123",
    team_id: "T123",
    thread_ts: THREAD_TS,
  },
  authenticator: "slack-webhook",
  issuer: "slack:T123",
  principalId: "slack:T123:bot:B0WORKFLOW",
  principalType: "service",
};

const workflowPost = message({
  author: undefined,
  raw: { bot_id: "B0WORKFLOW", subtype: "bot_message" },
});

describe("handleExplicitInvocation", () => {
  it("drops the agent's own messages", async () => {
    const result = await handleExplicitInvocation(
      inboundContext(),
      message({ author: slackAuthor({ isBot: true, isMe: true }) })
    );
    expect(result).toBeNull();
  });

  it.each([{}, { user: "" }, { user: "U123" }])(
    "drops messages without a verified author instead of sharing a principal (%o)",
    async (raw) => {
      const result = await handleExplicitInvocation(
        inboundContext(),
        message({ author: undefined, raw })
      );
      expect(result).toBeNull();
    }
  );

  it("gives an authorless bot post a per-bot service principal", async () => {
    const result = await handleExplicitInvocation(
      inboundContext(),
      workflowPost
    );
    expect(result).toStrictEqual({ auth: workflowPostAuth });
  });

  it.each(["", "U123", "b0workflow", "B0-WORKFLOW", 42])(
    "drops an authorless post with the invalid bot ID %j",
    async (botId) => {
      const result = await handleExplicitInvocation(
        inboundContext(),
        message({ author: undefined, raw: { bot_id: botId } })
      );
      expect(result).toBeNull();
    }
  );
});

describe("selectInboundHandlers", () => {
  it("defaults mentions and DMs to explicit invocation without a custom onMessage", () => {
    const handlers = selectInboundHandlers({}, true);
    expect(handlers.onAppMention).toBe(handleExplicitInvocation);
    expect(handlers.onDirectMessage).toBe(handleExplicitInvocation);
    expect(handlers.onMessage).toBeTypeOf("function");
  });

  it("registers no message handler when automatic replies are disabled", () => {
    expect(selectInboundHandlers({}, false).onMessage).toBeUndefined();
  });

  it("lets a custom onMessage receive mentions and DMs", () => {
    expect(selectInboundHandlers({ onMessage: custom }, true)).toStrictEqual({
      onAppMention: undefined,
      onDirectMessage: undefined,
      onMessage: custom,
    });
  });

  it("keeps explicitly supplied mention and DM handlers", () => {
    const handlers = {
      onAppMention: custom,
      onDirectMessage: custom,
      onMessage: custom,
    };
    expect(selectInboundHandlers(handlers, true)).toStrictEqual(handlers);
  });
});

describe("createSlackInboundHandlers", () => {
  it("leaves the message hook absent when automatic replies are disabled", () => {
    const config = configuredChannel({ autoReply: false });
    expect(config.onMessage).toBeUndefined();
    expect(config.onAppMention).toBeTypeOf("function");
  });

  it("routes mentions and DMs to a custom onMessage with profile context", async () => {
    const onMessage = vi.fn<Handler>(() => ({ auth: userAuth }));
    const config = configuredChannel({ onMessage });
    expect(config.onAppMention).toBeUndefined();
    expect(config.onDirectMessage).toBeUndefined();
    const ctx = context(false);
    const incoming = message({ text: "<@UAGENT> hello" });
    await expect(config.onMessage?.(ctx, incoming)).resolves.toStrictEqual(
      accepted(userAuth)
    );
    expect(onMessage).toHaveBeenCalledWith(ctx, incoming);
  });

  it.each(["onAppMention", "onDirectMessage", "onMessage"] as const)(
    "enriches accepted messages through %s without changing their payload",
    async (hook) => {
      const config = configuredChannel();
      const incoming = message({ text: "Ask <@U456>" });
      const original = structuredClone(incoming);
      const result = await config[hook]?.(context(true, ["U123"]), incoming);
      expect(result?.auth).toStrictEqual(userAuth);
      expect(result?.context?.[0]).toContain(
        'Sender: "Resolved name" (<@U123>)'
      );
      expect(result?.context?.[0]).toContain('"Resolved name" (<@U456>)');
      expect(incoming).toStrictEqual(original);
    }
  );

  it("skips profile lookups when custom routing rejects a message", async () => {
    const config = configuredChannel({ onAppMention: () => null });
    const ctx = context(false);
    await expect(config.onAppMention?.(ctx, message())).resolves.toBeNull();
    expect(ctx.slack.request).not.toHaveBeenCalled();
  });

  it("dispatches a Workflow bot's mention with eve's service identity", async () => {
    const config = configuredChannel();
    const workflowBot = message({
      author: slackAuthor({ isBot: true, userId: "UWORKFLOW" }),
    });
    await expect(
      config.onAppMention?.(context(false), workflowBot)
    ).resolves.toStrictEqual(accepted(workflowServiceAuth));

    // A mention delivered as an ordinary message event is also explicit.
    const ctx = inboundContext({ mentioned: true });
    await expect(config.onMessage?.(ctx, workflowBot)).resolves.toStrictEqual(
      accepted(workflowServiceAuth)
    );
    expect(ctx.isSubscribed).not.toHaveBeenCalled();
  });

  it("dispatches an authorless Workflow post's mention with a per-bot service identity", async () => {
    const config = configuredChannel();
    // The post has no Slack user and mentions no one, so no identity block is added.
    await expect(
      config.onAppMention?.(context(false), workflowPost)
    ).resolves.toStrictEqual({ auth: workflowPostAuth });

    // A mention delivered as an ordinary message event is also explicit.
    const ctx = inboundContext({ mentioned: true });
    await expect(config.onMessage?.(ctx, workflowPost)).resolves.toStrictEqual({
      auth: workflowPostAuth,
    });
    expect(ctx.isSubscribed).not.toHaveBeenCalled();
  });

  it("ignores unmentioned authorless bot posts without checking the thread", async () => {
    const config = configuredChannel({ autoReplyChannelIds: ["C123"] });
    const ctx = context(true);
    await expect(config.onMessage?.(ctx, workflowPost)).resolves.toBeNull();
    expect(ctx.isSubscribed).not.toHaveBeenCalled();
    expect(ctx.slack.request).not.toHaveBeenCalled();
  });

  it("drops authorless mentions instead of sharing a principal", async () => {
    const config = configuredChannel();
    const ctx = context(false);
    await expect(
      config.onAppMention?.(
        ctx,
        message({ author: undefined, raw: { user: "U123" } })
      )
    ).resolves.toBeNull();
    expect(ctx.slack.request).not.toHaveBeenCalled();
  });

  it("ignores the agent's own mentions", async () => {
    const config = configuredChannel();
    const ctx = inboundContext({ mentioned: true });
    const own = message({ author: slackAuthor({ isBot: true, isMe: true }) });
    await expect(config.onAppMention?.(ctx, own)).resolves.toBeNull();
    await expect(config.onMessage?.(ctx, own)).resolves.toBeNull();
  });

  it("ignores unmentioned bot messages without checking the thread", async () => {
    const config = configuredChannel();
    const ctx = context(true, ["UBOT"]);
    await expect(
      config.onMessage?.(
        ctx,
        message({ author: slackAuthor({ isBot: true, userId: "UBOT" }) })
      )
    ).resolves.toBeNull();
    expect(ctx.isSubscribed).not.toHaveBeenCalled();
    expect(ctx.slack.request).not.toHaveBeenCalled();
  });

  it("ignores messages outside subscribed threads", async () => {
    const config = configuredChannel();
    const ctx = context(false, ["U123"]);
    await expect(config.onMessage?.(ctx, message())).resolves.toBeNull();
    expect(ctx.thread.listParticipants).not.toHaveBeenCalled();
  });

  it("accepts a message from the sole thread participant", async () => {
    const config = configuredChannel();
    await expect(
      config.onMessage?.(context(true, ["U123"]), message())
    ).resolves.toStrictEqual(accepted(userAuth));
  });

  it("rejects messages from group threads", async () => {
    const config = configuredChannel();
    await expect(
      config.onMessage?.(context(true, ["U123", "U456"]), message())
    ).resolves.toBeNull();
  });

  it("fails closed when participant lookup fails", async () => {
    const config = configuredChannel();
    await expect(
      config.onMessage?.(
        context(true, new Error("Slack unavailable")),
        message()
      )
    ).resolves.toBeNull();
  });

  describe("auto-reply channels", () => {
    const rootMessage = (overrides: Partial<SlackMessage> = {}) =>
      message({ threadTs: MESSAGE_TS, ...overrides });
    const rootAuth = slackAuth({ channelId: "C123", threadTs: MESSAGE_TS });
    const rootContext = () =>
      inboundContext({
        slack: { request: context(false).slack.request, threadTs: MESSAGE_TS },
      });

    it.each([undefined, "file_share"])(
      "accepts a new human post with subtype %s",
      async (subtype) => {
        const config = configuredChannel({ autoReplyChannelIds: ["C123"] });
        const ctx = rootContext();
        const result = await config.onMessage?.(
          ctx,
          rootMessage({ raw: { subtype }, text: "Can you help?" })
        );
        expect(result?.auth).toStrictEqual(rootAuth);
        expect(ctx.thread.listParticipants).not.toHaveBeenCalled();
      }
    );

    it.each([undefined, [], ["C999"], ["C12"]])(
      "does not invoke for an unconfigured channel (%j)",
      async (autoReplyChannelIds) => {
        const config = configuredChannel({ autoReplyChannelIds });
        await expect(
          config.onMessage?.(context(false), rootMessage())
        ).resolves.toBeNull();
      }
    );

    it.each([
      ["another bot", { author: slackAuthor({ isBot: true }) }],
      ["self", { author: slackAuthor({ isMe: true }) }],
      ["missing author", { author: undefined }],
      ["a bot subtype", { raw: { subtype: "bot_message" } }],
      ["a channel join", { raw: { subtype: "channel_join" } }],
    ])("does not automatically invoke for %s", async (_name, overrides) => {
      const config = configuredChannel({ autoReplyChannelIds: ["C123"] });
      await expect(
        config.onMessage?.(context(false), rootMessage(overrides))
      ).resolves.toBeNull();
    });

    it("rejects root replays without falling through to a custom handler", async () => {
      const onMessage = vi.fn<Handler>(() => null);
      const config = configuredChannel({
        autoReplyChannelIds: ["C123"],
        onMessage,
      });
      const ctx = context(true, ["U123"]);
      await expect(config.onMessage?.(ctx, rootMessage())).resolves.toBeNull();
      expect(onMessage).not.toHaveBeenCalled();
      expect(ctx.slack.request).not.toHaveBeenCalled();
    });

    it("does not dispatch when the subscription check fails", async () => {
      const config = configuredChannel({ autoReplyChannelIds: ["C123"] });
      const ctx = context(false);
      vi.mocked(ctx.isSubscribed).mockRejectedValue(new Error("Unavailable"));
      await expect(config.onMessage?.(ctx, rootMessage())).rejects.toThrow(
        "Unavailable"
      );
    });

    it("accepts roots but not follow-ups when autoReply is disabled", async () => {
      const config = configuredChannel({
        autoReply: false,
        autoReplyChannelIds: ["C123"],
      });
      await expect(
        config.onMessage?.(rootContext(), rootMessage())
      ).resolves.toStrictEqual(accepted(rootAuth));
      await expect(
        config.onMessage?.(context(true, ["U123"]), message())
      ).resolves.toBeNull();
    });

    it.each(["onMessage", "onAppMention", "onDirectMessage"] as const)(
      "preserves explicit invocation through %s in an existing session",
      async (hook) => {
        const config = configuredChannel({ autoReplyChannelIds: ["C123"] });
        const ctx = inboundContext({
          mentioned: hook !== "onDirectMessage",
          slack: { request: context(true).slack.request },
          subscribed: true,
          thread: { listParticipants: () => Promise.resolve(["U123", "U456"]) },
        });
        await expect(config[hook]?.(ctx, rootMessage())).resolves.toStrictEqual(
          accepted(userAuth)
        );
        expect(ctx.isSubscribed).not.toHaveBeenCalled();
      }
    );
  });
});
