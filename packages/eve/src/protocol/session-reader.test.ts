import { describe, expect, it } from "vitest";

import type { StoredLine } from "#protocol/session-events/envelope.js";
import { emptySessionView, foldLines } from "#protocol/session-projection/fold.js";
import { activeTurn } from "#protocol/session-projection/selectors.js";
import {
  callPlace,
  readerTasks,
  readerTurns,
  waitingOn,
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
  it("reads a turn waiting on work as active and waiting, and a settled one by its outcome", () => {
    const view = viewOf(
      started,
      [turn("turn_0"), run("run_0", "turn_0"), runSettled("run_0", "turn_0")],
      [{ data: { outcome: "failed", turnId: "turn_0" }, type: "turn.settled" }],
      [{ data: { deliveryId: "d_1" }, type: "delivery.admitted" }, turn("turn_1", "d_1")],
      [
        run("run_1", "turn_1"),
        call("c_1", "run_1"),
        {
          data: { callId: "c_1", taskId: "t_1" },
          scope: { turnId: "turn_1" },
          type: "call.started",
        },
        runSettled("run_1", "turn_1"),
      ],
    );
    expect(readerTurns(view)).toEqual({
      turn_0: { status: "failed", turnId: "turn_0" },
      turn_1: { status: "active", turnId: "turn_1", waiting: true },
    });
    expect(activeTurn(view)?.turnId).toBe("turn_1");
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

describe("waitingOn", () => {
  const asked = [turn("turn_0"), run("run_0", "turn_0"), call("c_0", "run_0", { a: 1 })];

  it("names the open approval a call waits on, until it settles", () => {
    const open = viewOf(started, [...asked, runSettled("run_0", "turn_0"), approval("i_0", "c_0")]);
    expect(waitingOn(open, "c_0")).toBe("i_0");
    const declined = viewOf(
      started,
      [...asked, runSettled("run_0", "turn_0"), approval("i_0", "c_0")],
      [{ data: { interactionId: "i_0", outcome: "declined" }, type: "interaction.settled" }],
    );
    expect(waitingOn(declined, "c_0")).toBeUndefined();
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
        c_0: {
          callId: "c_0",
          outcome: "completed",
          output: "done",
          status: "settled",
          turnId: "turn_0",
        },
        c_1: {
          callId: "c_1",
          outcome: "completed",
          output: "done",
          status: "settled",
          turnId: "turn_0",
        },
      },
      kind: "agent",
      name: "helper",
      taskId: "t_0",
    });
  });
});
