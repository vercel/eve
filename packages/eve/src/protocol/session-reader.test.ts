import { describe, expect, it } from "vitest";

import type { StoredLine } from "#protocol/session-events/envelope.js";
import { emptySessionView, foldLines } from "#protocol/session-projection/fold.js";
import {
  activeTurnId,
  callPlace,
  callStatus,
  openSignIns,
  readerInputs,
  readerTasks,
  readerTurns,
  reportedCallStatus,
  runPlace,
} from "#protocol/session-reader.js";

const at = "2026-10-10T00:00:00.000Z";

function viewOf(...lines: (readonly object[])[]) {
  const view = emptySessionView();
  const stored: StoredLine[] = lines.map((facts) => ({ at, facts: [...facts] }) as StoredLine);
  foldLines(view, stored, 0);
  return view;
}

const started = [
  { data: {}, type: "session.started" },
  { data: { deliveryId: "d_0" }, type: "delivery.admitted" },
];
const turn = (turnId: string, deliveryId = "d_0") => ({
  data: { cause: { deliveryId }, follows: null, turnId },
  scope: { turnId },
  type: "turn.started",
});
const run = (runId: string, turnId: string) => ({
  data: { owner: { turnId }, runId },
  scope: { turnId },
  type: "model.requested",
});
const runSettled = (runId: string, turnId: string) => ({
  data: { outcome: "completed", runId },
  scope: { runId, turnId },
  type: "model.settled",
});
const call = (callId: string, runId: string, input: object = {}) => ({
  data: { callId, capability: { kind: "tool", name: `tool-${callId}` }, input, owner: { runId } },
  scope: { runId },
  type: "call.requested",
});
const approval = (interactionId: string, callId: string) => ({
  data: {
    interactionId,
    request: { kind: "approval", prompt: `Approve ${callId}?` },
    subject: { callId },
  },
  type: "interaction.opened",
});

describe("turns and steps", () => {
  it("reads a paused turn as active and waiting, and a settled one by its outcome", () => {
    const view = viewOf(
      started,
      [turn("turn_0"), run("run_0", "turn_0"), runSettled("run_0", "turn_0")],
      [{ data: { outcome: "failed", turnId: "turn_0" }, type: "turn.settled" }],
      [{ data: { deliveryId: "d_1" }, type: "delivery.admitted" }, turn("turn_1", "d_1")],
      [{ data: { awaiting: [{ taskId: "t" }], turnId: "turn_1" }, type: "turn.paused" }],
    );
    expect(readerTurns(view)).toEqual({
      turn_0: { status: "failed", turnId: "turn_0" },
      turn_1: { status: "active", turnId: "turn_1", waiting: true },
    });
    expect(activeTurnId(view)).toBe("turn_1");
  });

  it("places each run at its step within its turn, and each call at its run's", () => {
    const view = viewOf(started, [
      turn("turn_0"),
      run("run_0", "turn_0"),
      call("c_0", "run_0"),
      runSettled("run_0", "turn_0"),
      run("run_1", "turn_0"),
      call("c_1", "run_1"),
    ]);
    expect(runPlace(view, "run_0")).toEqual({ stepIndex: 0, turnId: "turn_0" });
    expect(runPlace(view, "run_1")).toEqual({ stepIndex: 1, turnId: "turn_0" });
    expect(callPlace(view, "c_1")).toEqual({ stepIndex: 1, turnId: "turn_0" });
  });
});

describe("call status", () => {
  const asked = [turn("turn_0"), run("run_0", "turn_0"), call("c_0", "run_0", { a: 1 })];

  it("waits on its own open approval, and reads a declined one as rejected", () => {
    const open = viewOf(started, [...asked, runSettled("run_0", "turn_0"), approval("i_0", "c_0")]);
    expect(reportedCallStatus(open, "c_0")).toBe("awaiting-input");
    const declined = viewOf(
      started,
      [...asked, runSettled("run_0", "turn_0"), approval("i_0", "c_0")],
      [{ data: { interactionId: "i_0", outcome: "declined" }, type: "interaction.settled" }],
    );
    expect(reportedCallStatus(declined, "c_0")).toBe("rejected");
  });

  it("interrupts a call still running when its turn settled or the stream stopped", () => {
    const running = viewOf(started, asked);
    expect(callStatus(running, "c_0")).toBe("running");
    expect(callStatus(running, "c_0", { streaming: false })).toBe("interrupted");
    const ended = viewOf(started, asked, [
      runSettled("run_0", "turn_0"),
      { data: { outcome: "cancelled", turnId: "turn_0" }, type: "turn.settled" },
    ]);
    expect(callStatus(ended, "c_0")).toBe("interrupted");
  });

  it("maps settled outcomes, an interrupted call reading as cancelled", () => {
    const view = viewOf(started, [
      ...asked,
      call("c_1", "run_0"),
      { data: { callId: "c_0", outcome: "interrupted" }, type: "call.settled" },
      { data: { callId: "c_1", outcome: "rejected" }, type: "call.settled" },
    ]);
    expect(reportedCallStatus(view, "c_0")).toBe("cancelled");
    expect(reportedCallStatus(view, "c_1")).toBe("rejected");
  });
});

describe("requests", () => {
  it("rebuilds a request with its call's tool and input, and its answer once settled", () => {
    const view = viewOf(
      started,
      [turn("turn_0"), run("run_0", "turn_0"), call("c_0", "run_0", { a: 1 })],
      [runSettled("run_0", "turn_0"), approval("i_0", "c_0")],
      [
        { data: { deliveryId: "d_1" }, type: "delivery.admitted" },
        {
          data: { deliveryId: "d_1", interactionId: "i_0", responseId: "r_0", value: {} },
          type: "response.submitted",
        },
      ],
    );
    expect(readerInputs(view).i_0).toMatchObject({
      pendingResponseIds: ["r_0"],
      request: {
        action: { callId: "c_0", input: { a: 1 }, toolName: "tool-c_0" },
        kind: "tool-approval",
        prompt: "Approve c_0?",
      },
      status: "open",
      stepIndex: 0,
      turnId: "turn_0",
    });
  });

  it("names a relayed request's call from its origin, since the asker's call is elsewhere", () => {
    const view = viewOf(started, [
      turn("turn_0"),
      run("run_0", "turn_0"),
      call("c_0", "run_0"),
      runSettled("run_0", "turn_0"),
      {
        data: {
          interactionId: "i_0",
          origin: {
            call: { callId: "child-call", input: { q: 1 }, name: "ask_question" },
            interactionId: "child-i",
            sessionId: "child",
          },
          request: { kind: "question", prompt: "Which?" },
          subject: { callId: "c_0" },
        },
        type: "interaction.opened",
      },
    ]);
    expect(readerInputs(view).i_0).toMatchObject({
      callId: "c_0",
      request: { action: { callId: "child-call", input: { q: 1 }, toolName: "ask_question" } },
    });
  });
});

describe("tasks and sign-ins", () => {
  it("lists a task's calls with outputs, following a shared result", () => {
    const view = viewOf(started, [
      turn("turn_0"),
      run("run_0", "turn_0"),
      call("c_0", "run_0"),
      call("c_1", "run_0"),
      {
        data: { kind: "agent", name: "helper", startedBy: { callId: "c_0" }, taskId: "t_0" },
        type: "task.started",
      },
      { data: { callId: "c_0", taskId: "t_0" }, type: "call.started" },
      { data: { callId: "c_1", taskId: "t_0" }, type: "call.started" },
      { data: { callId: "c_0", outcome: "completed", output: "done" }, type: "call.settled" },
      {
        data: { callId: "c_1", outcome: "completed", outputOf: { callId: "c_0" } },
        type: "call.settled",
      },
    ]);
    expect(readerTasks(view).t_0).toEqual({
      calls: {
        c_0: { callId: "c_0", output: "done", status: "completed", turnId: "turn_0" },
        c_1: { callId: "c_1", output: "done", status: "completed", turnId: "turn_0" },
      },
      kind: "agent",
      name: "helper",
      taskId: "t_0",
    });
  });

  it("shows open sign-ins, marking those that resume through a callback", () => {
    const view = viewOf(started, [
      turn("turn_0"),
      {
        data: {
          interactionId: "s_0",
          request: {
            kind: "sign-in",
            prompt: "Sign in to GitHub",
            signIn: { callbackUrl: "https://example.test/cb", name: "github" },
          },
          subject: { turnId: "turn_0" },
        },
        type: "interaction.opened",
      },
    ]);
    expect(openSignIns(view)).toEqual([
      expect.objectContaining({
        attemptId: "s_0",
        awaitsCallback: true,
        name: "github",
        status: "required",
        turnId: "turn_0",
      }),
    ]);
  });
});
