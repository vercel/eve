import { describe, expect, it, vi } from "vitest";

import type { SessionContext } from "#public/definitions/callback-context.js";
import { defaultEvents } from "#public/channels/discord/defaults.js";
import type { DiscordEventContext } from "#public/channels/discord/discordChannel.js";

const sessionCtx = {} as SessionContext;

function channelStub(input: { readonly guild: boolean }) {
  const followup = vi.fn().mockResolvedValue({ id: "private" });
  const post = vi.fn().mockResolvedValue({ id: "public" });
  const startTyping = vi.fn().mockResolvedValue(undefined);
  const partialDiscord: Partial<DiscordEventContext["discord"]> = {
    applicationId: "APP1",
    followup,
    guildId: input.guild ? "G01" : undefined,
    interactionToken: "token",
    post,
    startTyping,
  };
  const partialChannel: Pick<DiscordEventContext, "discord"> = {
    discord: partialDiscord as DiscordEventContext["discord"],
  };
  const channel = partialChannel as DiscordEventContext;
  return { channel, followup, post, startTyping };
}

function requiredEvent() {
  return {
    authorization: { url: "https://connect.example.com/auth", userCode: "ABCD-1234" },
    description: "Connect your account to continue.",
    name: "notion",
    sequence: 0,
    stepIndex: 0,
    turnId: "turn-1",
  };
}

describe("Discord connection authorization defaults", () => {
  it("uses an ephemeral followup outside guilds", async () => {
    const { channel, followup, post } = channelStub({ guild: false });

    await defaultEvents["authorization.required"]!(requiredEvent(), channel, sessionCtx);

    expect(post).not.toHaveBeenCalled();
    expect(followup).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("https://connect.example.com/auth"),
        flags: 64,
      }),
    );
  });

  it("keeps shared-channel status link-free and follows up ephemerally", async () => {
    const { channel, followup, post } = channelStub({ guild: true });

    await defaultEvents["authorization.required"]!(requiredEvent(), channel, sessionCtx);

    expect(post).toHaveBeenCalledWith("Authorization required for Notion.");
    expect(String(post.mock.calls[0]?.[0])).not.toContain("https://");
    expect(followup).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("https://connect.example.com/auth"),
        flags: 64,
      }),
    );
  });

  it("posts authorization outcomes", async () => {
    const { channel, post, startTyping } = channelStub({ guild: true });

    await defaultEvents["authorization.completed"]!(
      { name: "notion", outcome: "authorized", sequence: 1, stepIndex: 0, turnId: "turn-1" },
      channel,
      sessionCtx,
    );

    expect(startTyping).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("Notion connected. Resuming.");
  });
});
