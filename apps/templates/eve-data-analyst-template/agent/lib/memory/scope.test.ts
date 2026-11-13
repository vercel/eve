import type { MemoryScopeContext } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";
import { describe, expect, it } from "vitest";

import { webAuth, localDevAuth, slackAuth } from "../testing/session";
import { byHumanPrincipal, bySlackChannel } from "./scope";

const scopeContext = (
  current: MemoryScopeContext["session"]["auth"]["current"]
): MemoryScopeContext => ({
  abortSignal: new AbortController().signal,
  channel: {},
  session: { auth: { current, initiator: current }, id: "session-1" },
});

type Caller = MemoryScopeContext["session"]["auth"]["current"];

const slackCaller = (overrides: Partial<NonNullable<Caller>> = {}): Caller => ({
  attributes: { channel_id: "C123", team_id: "T123", user_id: "U123" },
  authenticator: "slack-webhook",
  issuer: "slack:T123",
  principalId: "slack:T123:U123",
  principalType: "user",
  ...overrides,
});

const scopeFor = (current: Caller) => bySlackChannel(scopeContext(current));

describe(byHumanPrincipal, () => {
  it.each([
    ["a Slack user", slackAuth()],
    ["a non-Slack user", webAuth()],
    ["local development", localDevAuth()],
  ])("matches byPrincipal for %s", (_name, auth) => {
    const ctx = scopeContext(auth);
    expect(byHumanPrincipal(ctx)).toBe(byPrincipal(ctx));
    expect(byHumanPrincipal(ctx)).not.toBeNull();
  });

  it("disables memory for a Slack bot's service principal", () => {
    const ctx = scopeContext({
      ...slackAuth({ userId: "UWORKFLOW" }),
      principalId: "slack:T123:bot:UWORKFLOW",
      principalType: "service",
    });
    expect(byPrincipal(ctx)).not.toBeNull();
    expect(byHumanPrincipal(ctx)).toBeNull();
  });

  it.each([
    [
      "runtime callers",
      { ...webAuth("eve:app"), authenticator: "app", principalType: "runtime" },
    ],
    ["anonymous callers", { ...webAuth("anon"), principalType: "anonymous" }],
    ["unauthenticated sessions", null],
  ] as const)("disables memory for %s", (_name, auth) => {
    expect(byHumanPrincipal(scopeContext(auth))).toBeNull();
  });
});

describe(bySlackChannel, () => {
  it("scopes Slack users to their installation and channel", () => {
    expect(scopeFor(slackCaller())).toStrictEqual([
      "slack-channel",
      "slack:T123",
      "C123",
    ]);
  });

  it("shares one scope across users in the same channel", () => {
    expect(
      scopeFor(
        slackCaller({
          attributes: { channel_id: "C123", user_id: "U456" },
          principalId: "slack:T123:U456",
        })
      )
    ).toStrictEqual(scopeFor(slackCaller()));
  });

  it("accepts private channels", () => {
    expect(
      scopeFor(slackCaller({ attributes: { channel_id: "G123" } }))
    ).toStrictEqual(["slack-channel", "slack:T123", "G123"]);
  });

  it("uses the shared local-dev scope during local development", () => {
    expect(scopeFor(localDevAuth())).toBe("local-dev");
  });

  it("keeps the same channel ID separate across Slack workspaces", () => {
    const first = scopeFor(slackCaller());
    const second = scopeFor(
      slackCaller({ issuer: "slack:T999", principalId: "slack:T999:U123" })
    );
    expect(first).toStrictEqual(["slack-channel", "slack:T123", "C123"]);
    expect(second).toStrictEqual(["slack-channel", "slack:T999", "C123"]);
  });

  it.each(["c123", "C", "W123", "U123", "", "C123\n", "C-123"])(
    "disables memory for the malformed channel ID %j",
    (channelId) => {
      expect(
        scopeFor(slackCaller({ attributes: { channel_id: channelId } }))
      ).toBeNull();
    }
  );

  it.each([
    ["anonymous callers", null],
    ["DMs", slackCaller({ attributes: { channel_id: "D123" } })],
    ["missing channels", slackCaller({ attributes: {} })],
    [
      "array channel attributes",
      slackCaller({ attributes: { channel_id: ["C123"] } }),
    ],
    ["bots", slackCaller({ principalType: "service" })],
    ["missing issuers", slackCaller({ issuer: undefined })],
    ["issuers without a workspace", slackCaller({ issuer: "slack" })],
    ["anonymous Slack principals", slackCaller({ principalType: "anonymous" })],
    ["runtime Slack principals", slackCaller({ principalType: "runtime" })],
    ["non-Slack authenticators", slackCaller({ authenticator: "vercel-oidc" })],
  ])("disables memory for %s", (_name, caller) => {
    expect(scopeFor(caller)).toBeNull();
  });
});
