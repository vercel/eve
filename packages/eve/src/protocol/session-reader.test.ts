import { describe, expect, it } from "vitest";

import type { StoredLine } from "#protocol/session-events/envelope.js";
import { emptySessionView, foldLines } from "#protocol/session-projection/fold.js";
import { activeTurn, activity } from "#protocol/session-projection/selectors.js";
import {
  callLabel,
  callState,
  callOutputSource,
  waiting,
} from "#protocol/session-projection/selectors.js";
import { callPlace, interaction, runPlace } from "#protocol/session-reader.js";

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
    expect(view.turns.turn_0).toMatchObject({ status: "settled", outcome: "failed" });
    expect(view.turns.turn_1?.status).toBe("running");
    expect(waiting(view, "turn_1")?.on).toBe("work");
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

describe("where a call stands", () => {
  const asked = [turn("turn_0"), run("run_0", "turn_0"), call("c_0", "run_0", { a: 1 })];

  it("waits on its own approval until it settles, then starts and ends", () => {
    const open = viewOf(started, [...asked, runSettled("run_0", "turn_0"), approval("i_0", "c_0")]);
    expect(callState(open, "c_0")).toBe("approval");
    expect(waiting(open, { callId: "c_0" })).toMatchObject({
      interactions: [{ interactionId: "i_0" }],
      on: "person",
    });
    const declined = viewOf(
      started,
      [...asked, runSettled("run_0", "turn_0"), approval("i_0", "c_0")],
      [{ data: { interactionId: "i_0", outcome: "declined" }, type: "interaction.settled" }],
    );
    expect(callState(declined, "c_0")).toBe("requested");
    expect(waiting(declined, { callId: "c_0" })).toBeUndefined();
    const ended = (outcome: string) =>
      callState(
        viewOf(started, [
          ...asked,
          { data: { callId: "c_0" }, type: "call.started" },
          { data: { callId: "c_0", outcome }, type: "call.settled" },
        ]),
        "c_0",
      );
    expect(ended("completed")).toBe("completed");
    expect(ended("rejected")).toBe("rejected");
    expect(ended("interrupted")).toBe("cancelled");
    expect(ended("abandoned")).toBe("cancelled");
    expect(ended("an-outcome-a-newer-eve-adds")).toBe("failed");
  });

  it("is blocked while its task's question waits, and running once it's answered", () => {
    const task = [
      ...asked,
      {
        data: { kind: "agent", name: "helper", startedBy: { callId: "c_0" }, taskId: "t_0" },
        type: "task.started",
      },
      { data: { callId: "c_0", taskId: "t_0" }, type: "call.started" },
    ];
    expect(callState(viewOf(started, task), "c_0")).toBe("running");
    const question = {
      data: {
        interactionId: "i_1",
        request: { kind: "question", prompt: "Which repo?" },
        subject: { taskId: "t_0" },
      },
      type: "interaction.opened",
    };
    const blocked = viewOf(started, [...task, question]);
    expect(callState(blocked, "c_0")).toBe("blocked");
    expect(waiting(blocked, { taskId: "t_0" })).toEqual(waiting(blocked, { callId: "c_0" }));
    expect(waiting(blocked, { taskId: "t_0" })?.on).toBe("person");
    const answered = viewOf(started, [
      ...task,
      question,
      { data: { interactionId: "i_1", outcome: "accepted" }, type: "interaction.settled" },
    ]);
    expect(callState(answered, "c_0")).toBe("running");
  });

  it("labels a call by its tool's label, its progress while running, then its name", () => {
    const view = viewOf(started, asked);
    const row = view.calls.c_0!;
    expect(callLabel(row)).toBe("Tool c 0");
    expect(callLabel(row, { label: "Fetching" })).toBe("Fetching");
    expect(callLabel({ ...row, capability: { ...row.capability, label: "Deploy" } })).toBe(
      "Deploy",
    );
    expect(callLabel({ ...row, status: "settled", label: "Deployed" }, { label: "Fetching" })).toBe(
      "Deployed",
    );
  });
});

describe("interaction", () => {
  it("keeps a sign-in callback out of the display projection without changing its wire row", () => {
    const view = viewOf(started, [
      turn("turn_0"),
      {
        type: "interaction.opened",
        data: {
          interactionId: "sign-in",
          subject: { turnId: "turn_0" },
          request: {
            kind: "sign-in",
            prompt: "Connect the calendar",
            signIn: {
              name: "calendar",
              url: "https://calendar.example/authorize",
              callbackUrl: "https://agent.example/callback",
            },
          },
        },
      },
    ]);
    expect(interaction(view, "sign-in")?.request.signIn).toEqual({
      name: "calendar",
      url: "https://calendar.example/authorize",
    });
    expect(view.interactions["sign-in"]?.request.signIn?.callbackUrl).toBe(
      "https://agent.example/callback",
    );
  });
  it("shows the latest unsettled answer without closing the prompt, then the deciding answer", () => {
    const view = viewOf(started, [
      turn("turn_0"),
      run("run_0", "turn_0"),
      call("c_0", "run_0"),
      approval("i_0", "c_0"),
    ]);
    expect(interaction(view, "missing")).toBeUndefined();
    expect(interaction(view, "i_0")).toMatchObject({
      interactionId: "i_0",
      request: { kind: "approval", prompt: "Approve c_0?" },
      call: { callId: "c_0", name: "tool-c_0", input: {} },
      status: "open",
      turnId: "turn_0",
      stepIndex: 0,
    });
    const submit = (responseId: string, optionId: string) => ({
      type: "response.submitted",
      data: { responseId, interactionId: "i_0", deliveryId: "d_0", value: { optionId } },
    });
    foldLines(
      view,
      [{ at, facts: [submit("r_0", "deny"), submit("r_1", "approve")] }],
      view.position,
    );
    expect(interaction(view, "i_0")).toMatchObject({
      status: "open",
      answer: { interactionId: "i_0", optionId: "approve" },
    });
    foldLines(
      view,
      [
        {
          at,
          facts: [{ type: "response.settled", data: { responseId: "r_1", outcome: "refused" } }],
        },
      ],
      view.position,
    );
    expect(interaction(view, "i_0")?.answer).toEqual({ interactionId: "i_0", optionId: "deny" });
    foldLines(
      view,
      [
        {
          at,
          facts: [
            {
              type: "interaction.settled",
              data: {
                interactionId: "i_0",
                outcome: "accepted",
                response: { optionId: "approve" },
              },
            },
          ],
        },
      ],
      view.position,
    );
    expect(interaction(view, "i_0")).toMatchObject({
      status: "settled",
      outcome: "accepted",
      answer: { interactionId: "i_0", optionId: "approve" },
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
    expect(view.tasks.t_0).toMatchObject({ kind: "agent", name: "helper", taskId: "t_0" });
    expect(callOutputSource(view, "c_0")?.output).toBe("done");
    expect(callOutputSource(view, "c_1")?.output).toBe("done");
  });
});

describe("activity", () => {
  it("reads a requested call as thinking, a started one as calling, and an approval as waiting", () => {
    const requested = viewOf(started, [
      turn("turn_0"),
      run("run_0", "turn_0"),
      call("c_1", "run_0"),
    ]);
    expect(activity(requested)).toEqual({ kind: "thinking" });

    // The run stays open while the call it made runs in its step.
    const running = viewOf(
      started,
      [turn("turn_0"), run("run_0", "turn_0"), call("c_1", "run_0")],
      [{ data: { callId: "c_1" }, scope: { runId: "run_0" }, type: "call.started" }],
    );
    expect(activity(running)).toEqual({ kind: "calling", names: ["Tool c 1"] });

    const asked = viewOf(
      started,
      [turn("turn_0"), run("run_0", "turn_0"), call("c_1", "run_0"), runSettled("run_0", "turn_0")],
      [approval("i_1", "c_1")],
    );
    expect(activity(asked)).toMatchObject({ kind: "waiting-on-person" });
  });
});
