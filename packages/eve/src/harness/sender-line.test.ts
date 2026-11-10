import { describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { rememberSender, senderLine } from "#harness/sender-line.js";

function user(principalId: string): SessionAuthContext {
  return { attributes: {}, authenticator: "test", principalId, principalType: "user" };
}

/** The line the model reads before `next`'s message, after messages from `earlier`. */
function lineAfter(
  earlier: readonly (SessionAuthContext | null)[],
  next: SessionAuthContext | null,
) {
  const session = earlier.reduce(rememberSender, {} as { state?: Record<string, unknown> });
  return senderLine(session.state, next);
}

describe("senderLine", () => {
  it.each([
    ["a session's first message", [], user("alice")],
    ["the same person speaking again", [user("alice")], user("alice")],
    [
      "the same person with new claims",
      [user("alice")],
      { ...user("alice"), attributes: { a: "b" } },
    ],
  ] as const)("adds nothing before %s", (_label, earlier, next) => {
    expect(lineAfter(earlier, next)).toBeUndefined();
  });

  it("names the sender and the one before by principal id when the speaker changes", () => {
    expect(lineAfter([user("alice"), user("bob")], user("alice"))).toBe(
      "The next message is from a different person than the message before it. " +
        "It is from alice. The message before it was from bob.",
    );
  });

  it("names someone who isn't signed in without an id", () => {
    expect(lineAfter([user("alice")], null)).toContain(
      "It is from someone who isn't signed in. The message before it was from alice.",
    );
  });
});
