import type { SlackChannelConfig } from "eve/channels/slack";
import { describe, expect, it, vi } from "vitest";

import { inboundContext, slackAuthor, slackMessage } from "../../testing/slack";
import {
  handleExplicitInvocation,
  selectInboundHandlers,
  withIdentityContext,
} from "./channel";
import { formatSlackIdentityContext } from "./identity";
import type { createSlackIdentityResolver } from "./identity";

type Resolver = ReturnType<typeof createSlackIdentityResolver>;
type Handler = NonNullable<SlackChannelConfig["onMessage"]>;
type Identities = Awaited<ReturnType<Resolver>>;

const customMention: Handler = () => null;
const customDirectMessage: Handler = () => null;
const customMessage: Handler = () => null;

const identitiesNamed = (names: Record<string, string>): Identities =>
  new Map(
    Object.entries(names).map(([userId, displayName]) => [
      userId,
      {
        displayName,
        profileImage: null,
        realName: null,
        userId,
        username: null,
      },
    ])
  );

describe(handleExplicitInvocation, () => {
  it("starts a turn with a per-user Slack principal for a human author", () => {
    const result = handleExplicitInvocation(
      inboundContext(),
      slackMessage({ text: "hello" })
    );

    expect(result).toMatchObject({
      auth: {
        attributes: { channel_id: "C123" },
        authenticator: "slack-webhook",
        issuer: "slack:T123",
        principalId: "slack:T123:U123",
        principalType: "user",
      },
    });
  });

  it.each([
    ["bots", { isBot: true }],
    ["the agent itself", { isMe: true }],
  ])("drops messages from %s", (_name, author) => {
    const result = handleExplicitInvocation(
      inboundContext(),
      slackMessage({ author: slackAuthor(author) })
    );

    expect(result).toBeNull();
  });

  it.each([{}, { user: "" }, { user: "U123" }])(
    "drops messages without a verified author instead of trusting raw.user (%o)",
    (raw) => {
      const result = handleExplicitInvocation(
        inboundContext(),
        slackMessage({ author: undefined, raw })
      );

      expect(result).toBeNull();
    }
  );
});

describe(selectInboundHandlers, () => {
  it("defaults mentions and DMs to explicit invocation without onMessage", () => {
    expect(selectInboundHandlers({})).toStrictEqual({
      onAppMention: handleExplicitInvocation,
      onDirectMessage: handleExplicitInvocation,
      onMessage: undefined,
    });
  });

  it("lets a caller's onMessage receive mentions and DMs", () => {
    expect(selectInboundHandlers({ onMessage: customMessage })).toStrictEqual({
      onAppMention: undefined,
      onDirectMessage: undefined,
      onMessage: customMessage,
    });
  });

  it("keeps explicitly supplied mention and DM handlers", () => {
    const handlers = {
      onAppMention: customMention,
      onDirectMessage: customDirectMessage,
      onMessage: customMessage,
    };

    expect(selectInboundHandlers(handlers)).toStrictEqual(handlers);
  });
});

describe(withIdentityContext, () => {
  it("returns undefined when no handler is supplied", () => {
    expect(withIdentityContext(undefined, vi.fn<Resolver>())).toBeUndefined();
  });

  it("skips profile lookups when the handler drops the message", async () => {
    const resolve = vi.fn<Resolver>();
    const handler = withIdentityContext(() => null, resolve);

    await expect(
      handler?.(inboundContext(), slackMessage())
    ).resolves.toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    ["after existing context", ["existing"]],
    ["as the only context", undefined],
  ])("appends the identity block %s", async (_case, context) => {
    const ctx = inboundContext();
    const message = slackMessage();
    const identities = identitiesNamed({ U123: "Sarah" });
    const resolve = vi.fn<Resolver>().mockResolvedValue(identities);
    const handler = withIdentityContext(
      () => ({ auth: null, context }),
      resolve
    );

    await expect(handler?.(ctx, message)).resolves.toStrictEqual({
      auth: null,
      context: [
        ...(context ?? []),
        formatSlackIdentityContext(message, identities),
      ],
    });
    expect(resolve).toHaveBeenCalledExactlyOnceWith(ctx, message);
  });

  it("returns the handler result unchanged when there are no identities", async () => {
    const original = { auth: null };
    const handler = withIdentityContext(
      () => original,
      vi.fn<Resolver>().mockResolvedValue(identitiesNamed({}))
    );

    await expect(handler?.(inboundContext(), slackMessage())).resolves.toBe(
      original
    );
  });
});
