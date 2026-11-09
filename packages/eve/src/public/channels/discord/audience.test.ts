import { describe, expect, it } from "vitest";

import { discordConversationSpace } from "#public/channels/discord/audience.js";
import type { DiscordChannelState } from "#public/channels/discord/discordChannel.js";

function state(input: Partial<DiscordChannelState>): DiscordChannelState {
  return { channelId: "c1", guildId: null, ...input } as DiscordChannelState;
}

describe("discordConversationSpace", () => {
  it("names a guild channel under its guild", () => {
    expect(discordConversationSpace(state({ guildId: "g1", channelType: 0 }))).toEqual({
      id: "discord:g1:c1",
      type: "channel",
      workspaceId: "discord:g1",
    });
  });

  it("reports DMs as direct and group DMs as groups", () => {
    expect(discordConversationSpace(state({ channelType: 1 }))).toEqual({
      id: "discord:c1",
      type: "direct",
      visibility: "private",
    });
    expect(discordConversationSpace(state({ channelType: 3 }))?.type).toBe("group");
  });

  it("reports a private thread as private and leaves other server channels unknown", () => {
    expect(discordConversationSpace(state({ guildId: "g1", channelType: 12 }))?.visibility).toBe(
      "private",
    );
    expect(discordConversationSpace(state({ guildId: "g1", channelType: 0 }))).not.toHaveProperty(
      "visibility",
    );
  });

  it("reports none before a channel is known, or for a proactive send to an unknown channel", () => {
    expect(discordConversationSpace(state({ channelId: null }))).toBeUndefined();
    expect(discordConversationSpace(state({}))).toBeUndefined();
  });
});
