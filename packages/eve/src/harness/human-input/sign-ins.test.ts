import { describe, expect, it } from "vitest";

import {
  ALICE,
  Turn,
  answer,
  approval,
  approvalsRequested,
  callback,
  cancel,
  challenge,
  heldOnSignIns,
  message,
  signInRequired,
} from "#internal/testing/human-input.js";

/** How each sign-in the turn reported ended. */
function outcomes(turn: Turn) {
  return turn.published("authorization.completed").map(({ data }) => ({
    attemptId: data.attemptId,
    outcome: data.outcome,
    reason: data.reason,
  }));
}

const SUPERSEDED = "Superseded by a newer authorization attempt.";

describe("sign-ins", () => {
  it("a sign-in publishes one sign-in per challenge and holds the turn", () => {
    const turn = heldOnSignIns(challenge("a1"));

    expect(turn.published("authorization.required").map(({ data }) => data)).toEqual([
      expect.objectContaining({
        attemptId: "a1",
        name: "weather",
        principalId: "alice",
        webhookUrl: "https://agent.example/callback/a1",
      }),
    ]);
    expect(turn.stored().next()).toEqual({ held: "input" });
    expect(turn.stored().humanInput.awaitedSignIns()).toEqual(["a1"]);
  });

  it("the step joins history without the calls that asked, so history never holds a waiting call", () => {
    const weather = {
      input: {},
      toolCallId: "call-weather",
      toolName: "weather",
      type: "tool-call" as const,
    };
    const clock = {
      input: {},
      toolCallId: "call-clock",
      toolName: "clock",
      type: "tool-call" as const,
    };
    const result = (call: typeof weather, value: string) => ({
      output: { type: "text" as const, value },
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      type: "tool-result" as const,
    });
    const turn = Turn.idle().interrupt(
      signInRequired(
        [challenge("a1")],
        ["call-weather"],
        [
          { content: [weather, clock], role: "assistant" },
          { content: [result(weather, "Sign in first."), result(clock, "noon")], role: "tool" },
        ],
      ),
    );

    expect(turn.events.filter((event) => event.type === "history.appended")).toEqual([
      { message: { content: [clock], role: "assistant" }, type: "history.appended" },
      { message: { content: [result(clock, "noon")], role: "tool" }, type: "history.appended" },
    ]);
  });

  describe("a step suspended on an approval", () => {
    const probe = {
      input: {},
      toolCallId: "call-probe",
      toolName: "auth-probe",
      type: "tool-call" as const,
    };
    const publish = approval("publish");
    const publishCall = {
      input: {},
      toolCallId: publish.action!.callId,
      toolName: "publish",
      type: "tool-call" as const,
    };
    const signal = {
      output: { type: "json" as const, value: { signIn: true } },
      toolCallId: probe.toolCallId,
      toolName: probe.toolName,
      type: "tool-result" as const,
    };
    /** One step checked Alice's access (a sign-in) and asked to publish (an approval). */
    const step = [
      { content: [probe, publishCall], role: "assistant" as const },
      { content: [signal], role: "tool" as const },
    ];
    const held = Turn.idle()
      .interrupt(approvalsRequested([publish], { messages: step }))
      .interrupt(signInRequired([challenge("a1")], [probe.toolCallId]));

    it("stays suspended without the call that asked, so the waiting call never enters history", () => {
      expect(held.appended()).toEqual([]);
      expect(held.humanInput.suspendedMessages()).toEqual([
        { content: [publishCall], role: "assistant" },
      ]);
      expect(held.stored().next()).toEqual({ held: "input" });
    });

    it("a cancel appends the step with a not-run result for the waiting call", () => {
      const cancelled = held.intake(cancel);

      expect(cancelled.appended()).toEqual([
        { content: [publishCall], role: "assistant" },
        {
          content: [
            expect.objectContaining({ toolCallId: publishCall.toolCallId, type: "tool-result" }),
          ],
          role: "tool",
        },
      ]);
      expect(cancelled.storesNothing()).toBe(true);
    });

    it("the approved call's own sign-in leaves the step too, and the turn holds on the newer attempt", () => {
      const approved = held.intake(answer("approve", publish.requestId));
      const run = approved.reported("calls.approved");
      expect(run).toHaveLength(1);

      const resumed = approved
        .intake({
          results: [],
          running: [],
          stopped: [publishCall.toolCallId],
          type: "calls.settled",
        })
        .interrupt(signInRequired([challenge("a2")], [publishCall.toolCallId]));

      expect(resumed.appended()).toEqual([]);
      expect(resumed.humanInput.suspendedMessages()).toEqual([]);
      expect(outcomes(resumed)).toEqual([
        { attemptId: "a1", outcome: "failed", reason: SUPERSEDED },
      ]);
      expect(resumed.stored().next()).toEqual({ held: "input" });
    });
  });

  it("only a callback closes a sign-in, so no answer is routed to it", () => {
    expect(heldOnSignIns(challenge("a1")).humanInput.openRequestIds()).toEqual(new Set());
  });

  it("a newer attempt of the same sign-in for the same person replaces the older one", () => {
    const bobs = challenge("bobs", { principal: { id: "bob", issuer: "test", type: "user" } });
    const turn = heldOnSignIns(
      challenge("first"),
      bobs,
      challenge("connector", { grant: "vercel-connect:github", name: "github-tool" }),
    ).interrupt(
      // The same name, or another scope of the same grant, is the same sign-in.
      signInRequired([
        challenge("second"),
        challenge("again", { grant: "vercel-connect:github", name: "github-connection" }),
      ]),
    );

    expect(outcomes(turn)).toEqual([
      { attemptId: "first", outcome: "failed", reason: SUPERSEDED },
      { attemptId: "connector", outcome: "failed", reason: SUPERSEDED },
    ]);
    expect(turn.humanInput.awaitedSignIns()).toEqual(["bobs", "second", "again"]);
  });

  it("a sign-in asked twice in one step waits only on the latest attempt", () => {
    const turn = Turn.idle().interrupt(
      signInRequired([challenge("older"), challenge("newer")], ["call-1", "call-2"]),
    );

    expect(turn.published("authorization.required")).toHaveLength(1);
    expect(turn.humanInput.awaitedSignIns()).toEqual(["newer"]);
  });

  it("a callback completes its sign-in and the call resumes as the person who started the turn", () => {
    const turn = heldOnSignIns(challenge("a1")).intake(callback("a1"));

    expect(outcomes(turn)).toEqual([{ attemptId: "a1", outcome: "authorized", reason: undefined }]);
    expect(turn.reported("sign-in.completed")).toEqual([
      {
        requester: ALICE,
        result: {
          attemptId: "a1",
          callback: { method: "GET", params: { code: "ok" } },
          hookUrl: "https://agent.example/callback/a1",
          instanceId: undefined,
          name: "weather",
          principal: { id: "alice", issuer: "test", type: "user" },
          resume: { nonce: "a1" },
        },
        type: "sign-in.completed",
      },
    ]);
    expect(turn.next()).toEqual({ run: "model" });
  });

  it("the turn stays held until every sign-in it waits on completes", () => {
    const turn = heldOnSignIns(challenge("a1"), challenge("c1", { name: "calendar" })).intake(
      callback("a1"),
    );

    expect(turn.next()).toEqual({ held: "input" });
    expect(turn.intake(callback("c1", "calendar")).next()).toEqual({ run: "model" });
  });

  it("a callback for an attempt that is not open completes nothing", () => {
    const open = heldOnSignIns(challenge("a1"));
    const replaced = open.interrupt(signInRequired([challenge("a2")]));

    expect(open.intake(callback("a1")).intake(callback("a1")).events).toEqual([]);
    expect(open.intake(callback("a1", "calendar")).events).toEqual([]);
    expect(replaced.intake(callback("a1")).events).toEqual([]);
    expect(replaced.intake(callback("a1")).next()).toEqual({ held: "input" });
  });

  it("a callback that can't be read fails the sign-in without handing it to the call", () => {
    const turn = heldOnSignIns(challenge("a1")).intake({
      attemptId: "a1",
      connectionName: "weather",
      outcome: "failed",
      type: "authorization.completed",
    });

    expect(outcomes(turn)).toEqual([{ attemptId: "a1", outcome: "failed", reason: undefined }]);
    expect(turn.reported("sign-in.completed")).toEqual([]);
    expect(turn.next()).toEqual({ run: "model" });
  });

  it("a message declines the open sign-ins and tells the model which ended", () => {
    const turn = heldOnSignIns(challenge("a1")).intake(message("Never mind."));

    expect(outcomes(turn)).toEqual([
      { attemptId: "a1", outcome: "declined", reason: "Cancelled because a new message arrived." },
    ]);
    expect(turn.reported("note")).toEqual([
      { text: expect.stringContaining("Sign-in to weather was cancelled"), type: "note" },
    ]);
    expect(turn.next()).toEqual({ run: "model" });
  });

  it("a cancel declines the open sign-ins", () => {
    const turn = heldOnSignIns(challenge("a1")).intake(cancel);

    expect(outcomes(turn)).toEqual([
      { attemptId: "a1", outcome: "declined", reason: "Cancelled." },
    ]);
    expect(turn.storesNothing()).toBe(true);
  });
});
