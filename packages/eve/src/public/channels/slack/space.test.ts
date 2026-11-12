import { describe, expect, it } from "vitest";

import { readSlackSpaceType, slackConversationSpace } from "#public/channels/slack/space.js";

describe("slackConversationSpace", () => {
  it("names the channel under the installation team", () => {
    expect(
      slackConversationSpace({ channelId: "C1", teamId: "T2", installationTeamId: "T1" }),
    ).toEqual({ id: "slack:T1:C1", type: "shared", workspaceId: "slack:T1" });
  });

  it("falls back to the event team, and reports none without a team", () => {
    expect(slackConversationSpace({ channelId: "C1", teamId: "T2" })?.id).toBe("slack:T2:C1");
    // A proactive send that names no installation team can't match its channel's inbound space.
    expect(slackConversationSpace({ channelId: "C1", teamId: null })).toBeUndefined();
  });

  it("reads the type from the event, else from the conversation ID", () => {
    expect(slackConversationSpace({ channelId: "D1", teamId: "T1" })).toMatchObject({
      type: "direct",
      visibility: "private",
    });
    expect(readSlackSpaceType({ channel_type: "im" })).toBe("direct");
    expect(readSlackSpaceType({ channel_type: "mpim" })).toBe("shared");
    expect(readSlackSpaceType({ channel_type: "group" })).toBe("shared");
    expect(readSlackSpaceType({})).toBeUndefined();
  });

  it("reports visibility only when Slack said", () => {
    expect(
      slackConversationSpace({ channelId: "C1", teamId: "T1", spaceVisibility: "public" }),
    ).toMatchObject({ visibility: "public" });
    expect(slackConversationSpace({ channelId: "C1", teamId: "T1" })).not.toHaveProperty(
      "visibility",
    );
  });

  it("reports none before a channel is known", () => {
    expect(slackConversationSpace({ channelId: null, teamId: "T1" })).toBeUndefined();
  });
});
