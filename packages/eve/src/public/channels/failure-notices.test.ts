import { describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "#protocol/session-event.js";
import { emptySessionView, foldLine } from "#protocol/session-projection/fold.js";
import { snapshotOf } from "#protocol/session-projection/session-view.js";
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

/** The view of a commit where Alice's turn failed, and with it the session when `ended`. */
function failedTurnView(ended: boolean) {
  const view = emptySessionView();
  const facts: SessionEvent[] = [
    { data: {}, type: "session.started" },
    { data: { deliveryId: "d_1" }, type: "delivery.admitted" },
    {
      data: { cause: { deliveryId: "d_1" }, follows: null, turnId: "turn_0" },
      type: "turn.started",
    },
    { data: { error: keyRejected, outcome: "failed", turnId: "turn_0" }, type: "turn.settled" },
    ...(ended
      ? [
          {
            data: { cause: { turnId: "turn_0" }, error: keyRejected, outcome: "failed" },
            type: "session.ended",
          } as SessionEvent,
        ]
      : []),
  ];
  foldLine(view, { at: "2026-01-01T00:00:00.000Z", facts }, 0);
  return snapshotOf(view);
}

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
    const ctx = { channel: { state: {}, thread: { post } }, view: failedTurnView(false) } as never;

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

  it("posts one notice when a failure ends the session: the session's, not its turn's", async () => {
    const post = vi.fn(async (_text: string) => undefined);
    const ctx = { channel: { state: {}, thread: { post } }, view: failedTurnView(true) } as never;

    await defaultEvents["turn.settled"]!(
      { data: { error: keyRejected, outcome: "failed", turnId: "turn_0" } } as never,
      ctx,
    );
    await defaultEvents["session.ended"]!(
      { data: { cause: { turnId: "turn_0" }, error: keyRejected, outcome: "failed" } } as never,
      ctx,
    );

    expect(post).toHaveBeenCalledOnce();
    expect(post.mock.calls[0]![0]).toContain("Start a new thread to continue");
  });
});
