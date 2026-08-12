import { describe, expect, it, vi } from "vitest";

import type { SessionContext } from "#public/definitions/callback-context.js";
import { createDefaultEvents } from "#public/channels/github/defaults.js";
import type { GitHubEventContext } from "#public/channels/github/githubChannel.js";

describe("GitHub connection authorization defaults", () => {
  it("posts a link-free status and the eventual outcome", async () => {
    const post = vi.fn().mockResolvedValue({ id: 1 });
    const partialThread: Partial<GitHubEventContext["thread"]> = { post };
    const partialChannel: Pick<GitHubEventContext, "thread"> = {
      thread: partialThread as GitHubEventContext["thread"],
    };
    const channel = partialChannel as GitHubEventContext;
    const events = createDefaultEvents();
    const ctx = {} as SessionContext;

    await events["authorization.required"]!(
      {
        authorization: { url: "https://connect.example.com/auth" },
        description: "Connect your account to continue.",
        name: "notion",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn-1",
      },
      channel,
      ctx,
    );
    await events["authorization.completed"]!(
      { name: "notion", outcome: "authorized", sequence: 1, stepIndex: 0, turnId: "turn-1" },
      channel,
      ctx,
    );

    expect(post.mock.calls[0]?.[0]).toBe(
      "Authorization required for Notion. Open the matching eve session to continue.",
    );
    expect(post.mock.calls[0]?.[0]).not.toContain("https://");
    expect(post.mock.calls[1]?.[0]).toBe("Notion connected. Resuming.");
  });
});
