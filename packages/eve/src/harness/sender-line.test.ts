import { describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { forgetSender, participantsOf, rememberSender, senderLine } from "#harness/sender-line.js";

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
        'It is from "alice". The message before it was from "bob".',
    );
  });

  it("adds nothing after the conversation was cleared", () => {
    const session = forgetSender(
      rememberSender({} as { state?: Record<string, unknown> }, user("alice")),
    );
    expect(senderLine(session.state, user("bob"))).toBeUndefined();
    expect(participantsOf(session.state, undefined)).toEqual([]);
  });

  it("names someone who isn't signed in without an id", () => {
    expect(lineAfter([user("alice")], null)).toContain(
      'It is from someone who isn\'t signed in. The message before it was from "alice".',
    );
  });
});

describe("participants", () => {
  it("records who has spoken without their attributes, the most recent last", () => {
    const slack = {
      ...user("bob"),
      attributes: { action_token: "xoxa-secret" },
      authenticator: "slack",
      subject: "U_BOB",
    };
    const session = [user("alice"), slack, null, user("alice")].reduce(
      rememberSender,
      {} as { state?: Record<string, unknown> },
    );

    expect(participantsOf(session.state, undefined)).toEqual([
      { authenticator: "slack", principalId: "bob", principalType: "user", subject: "U_BOB" },
      { authenticator: "test", principalId: "alice", principalType: "user" },
    ]);
    expect(JSON.stringify(session.state)).not.toContain("xoxa-secret");
  });

  it("keeps the 50 people who spoke most recently", () => {
    const people = Array.from({ length: 52 }, (_, index) => user(`person-${index}`));
    const session = people.reduce(rememberSender, {} as { state?: Record<string, unknown> });

    const kept = participantsOf(session.state, undefined).map((person) => person.principalId);
    expect(kept).toHaveLength(50);
    expect(kept[0]).toBe("person-2");
    expect(kept.at(-1)).toBe("person-51");
  });
});
