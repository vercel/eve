import { describe, expect, it } from "vitest";

import { signsInPrivately } from "#public/channels/discord/defaults.js";
import type { DiscordChannelState } from "#public/channels/discord/discordChannel.js";

const state: DiscordChannelState = {
  applicationId: "app",
  channelId: "channel",
  conversationId: "message",
  guildId: null,
  hasMessageAnchor: true,
  initialResponseSent: true,
  interactionToken: "token",
};

describe("signsInPrivately", () => {
  it("shows the challenge only in a one-to-one DM", () => {
    expect(signsInPrivately({ ...state, channelType: 1 })).toBe(true);
  });

  it("shows the challenge in a DM a Gateway message started", () => {
    expect(signsInPrivately({ ...state, channelType: 1, interactionToken: null })).toBe(true);
  });

  it.each([
    ["a group DM", { channelType: 3 }],
    ["a server channel", { channelType: 0, guildId: "guild" }],
    ["a conversation whose type it didn't record", {}],
    ["a session eve started itself", { channelType: undefined, interactionToken: null }],
  ])("keeps the challenge out of %s", (_, change) => {
    expect(signsInPrivately({ ...state, ...change })).toBe(false);
  });
});
