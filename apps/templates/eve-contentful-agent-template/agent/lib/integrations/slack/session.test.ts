import type { SessionAuthContext } from "eve/context";
import { describe, expect, it } from "vitest";

import { buildPermalink, slackThreadFromSession } from "./session";
import type { SlackSessionContext } from "./session";

const context = (
  initiator: SessionAuthContext["attributes"] | null,
  current: SessionAuthContext["attributes"] | null
): SlackSessionContext => ({
  session: {
    auth: {
      current: current ? { attributes: current } : null,
      initiator: initiator ? { attributes: initiator } : null,
    },
  },
});

describe("slackThreadFromSession", () => {
  it("prefers the session initiator", () => {
    expect(
      slackThreadFromSession(
        context(
          { channel_id: "C_INITIATOR", thread_ts: "1710000000.100" },
          { channel_id: "C_CURRENT", thread_ts: "1710000000.200" }
        )
      )
    ).toEqual({
      channelId: "C_INITIATOR",
      ts: "1710000000.100",
    });
  });

  it("falls back to the current principal", () => {
    expect(
      slackThreadFromSession(
        context(null, { channel_id: "C_CURRENT", thread_ts: "1710000000.200" })
      )
    ).toEqual({
      channelId: "C_CURRENT",
      ts: "1710000000.200",
    });
  });

  it("returns null when the thread attributes are incomplete", () => {
    expect(
      slackThreadFromSession(
        context(
          { channel_id: "C_MISSING_TS" },
          { channel_id: "C_WRONG_TYPE", thread_ts: ["1710000000"] }
        )
      )
    ).toBeNull();
  });
});

describe("buildPermalink", () => {
  it("builds a Slack permalink from a channel and timestamp", () => {
    expect(
      buildPermalink("C01234567", "1710000000.100", "slack.example.com")
    ).toBe("https://slack.example.com/archives/C01234567/p1710000000100");
  });
});
