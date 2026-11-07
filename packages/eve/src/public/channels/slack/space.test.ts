import { describe, expect, it } from "vitest";

import { readSlackSpaceType, slackConversationSpace } from "#public/channels/slack/space.js";

describe("slackConversationSpace", () => {
  it("names the channel under the installation team", () => {
    expect(
      slackConversationSpace({ channelId: "C1", teamId: "T2", installationTeamId: "T1" }),
    ).toEqual({ id: "slack:T1:C1", type: "channel", workspaceId: "slack:T1" });
  });

  it("falls back to the event team, then to the channel alone", () => {
    expect(slackConversationSpace({ channelId: "C1", teamId: "T2" })?.id).toBe("slack:T2:C1");
    expect(slackConversationSpace({ channelId: "C1", teamId: null })).toEqual({
      id: "slack:C1",
      type: "channel",
    });
  });

  it("reads the type from the event, else from the conversation ID", () => {
    expect(slackConversationSpace({ channelId: "D1", teamId: "T1" })?.type).toBe("direct");
    expect(
      slackConversationSpace({ channelId: "G1", teamId: "T1", spaceType: "group" })?.type,
    ).toBe("group");
    expect(readSlackSpaceType({ channel_type: "im" })).toBe("direct");
    expect(readSlackSpaceType({ channel_type: "mpim" })).toBe("group");
    expect(readSlackSpaceType({ channel_type: "group" })).toBe("channel");
    expect(readSlackSpaceType({})).toBeUndefined();
  });

  it("reports none before a channel is known", () => {
    expect(slackConversationSpace({ channelId: null, teamId: "T1" })).toBeUndefined();
  });
});
