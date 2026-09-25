import { describe, expect, it, vi } from "vitest";

import type { MessageCompletedStreamEvent } from "#protocol/message.js";
import { defaultEvents as discordEvents } from "#public/channels/discord/defaults.js";
import { createDefaultEvents as createGitHubEvents } from "#public/channels/github/defaults.js";
import { defaultEvents as teamsEvents } from "#public/channels/teams/defaults.js";
import { defaultEvents as telegramEvents } from "#public/channels/telegram/defaults.js";
import { defaultEvents as twilioEvents } from "#public/channels/twilio/defaults.js";

// A scheduled turn that holds on its tasks streams its model text as an
// interim `message.completed`, then the turn's reply. Every built-in channel
// posts only the reply.

function completed(message: string, interim: boolean): MessageCompletedStreamEvent["data"] {
  const data: MessageCompletedStreamEvent["data"] = {
    finishReason: "stop",
    message,
    sequence: 0,
    stepIndex: 0,
    turnId: "turn_0",
  };
  if (interim) data.interim = true;
  return data;
}

async function postsOf(
  handler: (event: MessageCompletedStreamEvent["data"], channel: never, ctx: never) => unknown,
  channel: Record<string, unknown>,
  post: ReturnType<typeof vi.fn>,
): Promise<unknown[]> {
  await handler(completed("Started the lookup.", true), channel as never, {} as never);
  await handler(completed("Q3 revenue is 4.2M.", false), channel as never, {} as never);
  return post.mock.calls.map(([message]) => message);
}

describe("built-in channel defaults", () => {
  it("post only the turn's reply, never an interim message", async () => {
    const discord = vi.fn();
    const telegram = vi.fn();
    const teams = vi.fn();
    const twilio = vi.fn();

    expect(
      await postsOf(discordEvents["message.completed"]!, { discord: { post: discord } }, discord),
    ).toEqual(["Q3 revenue is 4.2M."]);
    expect(
      await postsOf(
        telegramEvents["message.completed"]!,
        { telegram: { post: telegram } },
        telegram,
      ),
    ).toEqual(["Q3 revenue is 4.2M."]);
    expect(
      await postsOf(teamsEvents["message.completed"]!, { thread: { post: teams } }, teams),
    ).toEqual(["Q3 revenue is 4.2M."]);
    expect(
      await postsOf(
        twilioEvents["message.completed"]!,
        { twilio: { sendMessage: twilio } },
        twilio,
      ),
    ).toEqual(["Q3 revenue is 4.2M."]);
  });

  it("GitHub skips an interim message", async () => {
    const handler = createGitHubEvents()["message.completed"]!;
    const post = vi.fn();

    await handler(
      completed("Started the lookup.", true),
      { github: { post } } as never,
      {} as never,
    );

    expect(post).not.toHaveBeenCalled();
  });
});
