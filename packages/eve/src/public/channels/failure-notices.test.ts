import { describe, expect, it, vi } from "vitest";

import { failureNotice } from "#public/channels/reply.js";
import { defaultEvents } from "#public/channels/slack/defaults.js";

// What a person reads when their request fails: the one place a channel tells them what went
// wrong and what to do next.

const keyRejected = {
  code: "MODEL_AUTH_FAILED",
  hint: "Set AI_GATEWAY_API_KEY, or run `vercel env pull`.",
  id: "err_123",
  message: "The provider rejected the API key.",
};

describe("failure notices", () => {
  it("names a failure and what to do next: retry a turn, restart after a session", () => {
    expect(failureNotice({ error: keyRejected, outcome: "failed" }, "turn")).toBe(
      [
        "I hit an error while handling your request (MODEL_AUTH_FAILED: The provider rejected the API key.).",
        "Please try again, rephrase, or reach out if it keeps failing.",
        "Error id: err_123",
      ].join("\n\n"),
    );
    expect(
      failureNotice({ error: keyRejected, outcome: "failed" }, { restart: "message" }),
    ).toContain("Start a new message to continue.");
    expect(failureNotice({ outcome: "cancelled" }, "turn")).toBeUndefined();
  });

  it("posts how to fix a failure eve recognizes in Slack, for a turn and for the session", async () => {
    const post = vi.fn(async (_text: string) => undefined);
    const ctx = { channel: { thread: { post } } } as never;

    await defaultEvents["turn.settled"]!(
      { data: { error: keyRejected, outcome: "failed", turnId: "turn_0" } } as never,
      ctx,
    );
    await defaultEvents["session.ended"]!(
      { data: { error: keyRejected, outcome: "failed" } } as never,
      ctx,
    );

    const [turn, session] = post.mock.calls.map(([text]) => text);
    for (const text of [turn, session]) {
      expect(text).toContain("> The provider rejected the API key.");
      expect(text).toContain(
        "> **How to fix**\n> Set AI_GATEWAY_API_KEY, or run `vercel env pull`.",
      );
      expect(text).toContain("`err_123`");
    }
    expect(turn).toContain("I hit an error while handling your request");
    expect(session).toContain("Start a new thread to continue");
  });
});
