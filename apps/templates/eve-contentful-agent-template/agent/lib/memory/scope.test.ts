import type { MemoryScopeContext } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";
import { describe, expect, it } from "vitest";

import { localAuth, slackAuth } from "../testing/session";
import { byHumanPrincipal } from "./scope";

const scopeContext = (
  current: MemoryScopeContext["session"]["auth"]["current"]
): MemoryScopeContext => ({
  abortSignal: new AbortController().signal,
  channel: {},
  session: { auth: { current, initiator: current }, id: "session-1" },
});

describe("byHumanPrincipal", () => {
  it.each([
    ["a Slack user", slackAuth()],
    ["local development", localAuth()],
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
});
