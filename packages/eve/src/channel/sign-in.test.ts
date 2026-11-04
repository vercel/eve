import { describe, expect, it, vi } from "vitest";

import { postedIn, settleSignIn, showSignIn, type SignInSurface } from "#channel/sign-in.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { emptySessionView, foldLine } from "#protocol/session-projection/fold.js";
import type { SessionView } from "#protocol/session-projection/tables.js";

const turnId = "turn_0";

/** A turn waiting on Alice to connect GitHub; `responseId` makes it an approver's sign-in. */
function waitingOnGitHub(responseId?: string): SessionView {
  const view = emptySessionView();
  const facts: SessionEvent[] = [
    { data: {}, type: "session.started" },
    { data: { deliveryId: "d_1" }, type: "delivery.admitted" },
    { data: { cause: { deliveryId: "d_1" }, follows: null, turnId }, type: "turn.started" },
    {
      data: {
        audience: { principalIds: ["alice"] },
        interactionId: "sign-in-1",
        request: {
          kind: "sign-in",
          prompt: "Sign in to GitHub to continue.",
          signIn: { name: "github", url: "https://github.test/login", userCode: "ABCD" },
        },
        subject: responseId === undefined ? { turnId } : { responseId },
      },
      type: "interaction.opened",
    } as SessionEvent,
  ];
  foldLine(view, { at: "2026-01-01T00:00:00.000Z", facts }, 0);
  return view;
}

function surface(options: { private: boolean; delivers?: boolean; edits?: boolean }) {
  const state: { pendingSignIns?: Record<string, string> } = {};
  const posts: string[] = [];
  const surface: SignInSurface = {
    private: options.private,
    postChallenge: vi.fn(async () => "challenge-1"),
    ...(options.delivers !== undefined && {
      deliverPrivately: vi.fn(async () => options.delivers!),
    }),
    post: vi.fn(async (text: string) => {
      posts.push(text);
      return `status-${posts.length}`;
    }),
    ...(options.edits === true && { edit: vi.fn(async () => {}) }),
    typing: vi.fn(async () => {}),
    posted: postedIn(state, "pendingSignIns"),
  };
  return { posts, state, surface };
}

describe("a sign-in on a channel", () => {
  it("posts its challenge in a conversation that is the person's, once", async () => {
    const { state, surface: dm } = surface({ private: true });
    await showSignIn(waitingOnGitHub(), "sign-in-1", dm);
    await showSignIn(waitingOnGitHub(), "sign-in-1", dm);

    expect(dm.postChallenge).toHaveBeenCalledTimes(1);
    expect(dm.postChallenge).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "Github", principalId: "alice", userCode: "ABCD" }),
    );
    expect(state.pendingSignIns).toEqual({ github: "challenge-1" });
  });

  it("keeps the challenge out of a group: sent privately, or a pointer to a DM", async () => {
    const delivered = surface({ delivers: true, private: false });
    await showSignIn(waitingOnGitHub(), "sign-in-1", delivered.surface);
    expect(delivered.surface.postChallenge).not.toHaveBeenCalled();
    expect(delivered.posts).toEqual([
      "Authorization required for Github. I sent you the sign-in details privately.",
    ]);

    const undelivered = surface({ private: false });
    await showSignIn(waitingOnGitHub(), "sign-in-1", undelivered.surface);
    expect(undelivered.posts).toEqual([
      "Authorization required for Github. Continue in a direct message with this agent.",
    ]);
    expect(undelivered.posts.join()).not.toContain("github.test");
  });

  it("edits what it posted when the sign-in ends, or posts the ending, and shows the turn resuming", async () => {
    const view = waitingOnGitHub();
    const editing = surface({ edits: true, private: false });
    await showSignIn(view, "sign-in-1", editing.surface);
    await settleSignIn(view, { interactionId: "sign-in-1", outcome: "accepted" }, editing.surface);
    expect(editing.surface.edit).toHaveBeenCalledWith("status-1", "Github connected.");
    expect(editing.surface.typing).toHaveBeenCalledWith("Connected. Resuming...");
    expect(editing.state.pendingSignIns).toEqual({});

    const posting = surface({ private: true });
    await showSignIn(view, "sign-in-1", posting.surface);
    await settleSignIn(
      view,
      { interactionId: "sign-in-1", outcome: "expired", reason: "no answer" },
      posting.surface,
    );
    expect(posting.posts).toEqual(["Github sign-in timed out (no answer)."]);
    expect(posting.surface.typing).not.toHaveBeenCalled();
  });

  it("leaves an approver's sign-in to its approval's prompt", async () => {
    const { surface: dm } = surface({ private: true });
    await showSignIn(waitingOnGitHub("response-1"), "sign-in-1", dm);
    expect(dm.postChallenge).not.toHaveBeenCalled();
  });
});
