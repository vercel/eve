import { describe, expect, it } from "vitest";

import type { SessionEvent } from "#protocol/session-event.js";
import { emptySessionView, foldLine } from "#protocol/session-projection/fold.js";
import { openInteractions, waiting } from "#protocol/session-projection/selectors.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import { announceWaiting } from "#harness/session-machine/waiting.js";

const turnId = "turn_0";

function viewOf(...lines: SessionEvent[][]): SessionView {
  const view = emptySessionView();
  for (const facts of lines)
    foldLine(view, { at: "2026-01-01T00:00:00.000Z", facts }, view.position);
  return view;
}

const started: SessionEvent[] = [
  { data: {}, type: "session.started" },
  { data: { deliveryId: "d_1" }, type: "delivery.admitted" },
  {
    data: { cause: { deliveryId: "d_1" }, follows: null, turnId },
    scope: { turnId },
    type: "turn.started",
  },
  { data: { deliveryId: "d_1", parts: [], turnId }, scope: { turnId }, type: "delivery.consumed" },
  { data: { owner: { turnId }, runId: "run_0" }, scope: { turnId }, type: "model.requested" },
];
const callRequested: SessionEvent = {
  data: { callId: "c_1", capability: { kind: "tool", name: "deploy" }, owner: { runId: "run_0" } },
  scope: { runId: "run_0", turnId },
  type: "call.requested",
};
const modelSettled: SessionEvent = {
  data: { outcome: "completed", runId: "run_0" },
  scope: { runId: "run_0", turnId },
  type: "model.settled",
};
const approval: SessionEvent = {
  data: {
    interactionId: "i_1",
    request: { kind: "approval", prompt: "Deploy?" },
    subject: { callId: "c_1" },
  },
  scope: { turnId },
  type: "interaction.opened",
};

describe("waiting", () => {
  it("waits on the session while the model runs, and an interaction once only an answer can go on", () => {
    expect(waiting(viewOf(started, [callRequested, approval]), turnId)).toEqual({ on: "session" });
    expect(waiting(viewOf(started, [callRequested, approval, modelSettled]), turnId)).toMatchObject(
      { interactions: [{ interactionId: "i_1" }], on: "interaction" },
    );
  });

  it("waits on the calls a turn made while they run", () => {
    const view = viewOf(started, [
      callRequested,
      { data: { callId: "c_1", taskId: "t_1" }, scope: { turnId }, type: "call.started" },
      modelSettled,
    ]);
    expect(waiting(view, turnId)).toMatchObject({ calls: [{ callId: "c_1" }], on: "work" });
  });

  it("includes every working task when a task wait parks", () => {
    const view = viewOf(started, [
      callRequested,
      {
        data: { kind: "agent", name: "helper", startedBy: { callId: "c_1" }, taskId: "t_1" },
        type: "task.started",
      },
      { data: { callId: "c_1", taskId: "t_1" }, type: "call.started" },
      {
        data: {
          callId: "c_wait",
          capability: { kind: "control", name: "eve__task_wait" },
          owner: { runId: "run_0" },
        },
        type: "call.requested",
      },
      { data: { callId: "c_wait" }, type: "call.started" },
      modelSettled,
    ]);
    expect(waiting(view, turnId)).toMatchObject({ on: "work", tasks: [{ taskId: "t_1" }] });
  });

  it("waits on the interaction signing in for a call until it calls back", () => {
    const signIn: SessionEvent = {
      data: {
        interactionId: "i_github",
        request: { kind: "sign-in", prompt: "Sign in to GitHub", signIn: { name: "github" } },
        subject: { turnId },
      },
      scope: { turnId },
      type: "interaction.opened",
    };
    const stopped = [
      callRequested,
      { data: { callId: "c_1" }, scope: { turnId }, type: "call.started" },
      modelSettled,
    ] as SessionEvent[];
    expect(waiting(viewOf(started, [...stopped, signIn]), turnId)).toMatchObject({
      interactions: [{ interactionId: "i_github" }],
      on: "interaction",
    });
    const calledBack = viewOf(
      started,
      stopped,
      [signIn],
      [
        {
          data: { interactionId: "i_github", outcome: "accepted" },
          scope: { turnId },
          type: "interaction.settled",
        },
      ],
    );
    expect(waiting(calledBack, turnId)).toEqual({ on: "session" });
  });

  it("waits on the session for a task cancel, though the task asked for input", () => {
    const taskId = "t_1";
    const view = viewOf(
      started,
      [
        callRequested,
        {
          data: { kind: "tool", name: "deploy", startedBy: { callId: "c_1" }, taskId },
          scope: { taskId },
          type: "task.started",
        },
        { data: { callId: "c_1", taskId }, scope: { taskId, turnId }, type: "call.started" },
        modelSettled,
      ],
      [
        {
          data: {
            interactionId: "i_task",
            origin: {
              call: { callId: "c_1", name: "deploy" },
              interactionId: "i_task",
              sessionId: "wrun_task",
            },
            request: { kind: "question", prompt: "Sign off?" },
            subject: { callId: "c_1" },
          },
          scope: { taskId },
          type: "interaction.opened",
        },
      ],
      [{ data: { owner: { turnId }, runId: "run_1" }, scope: { turnId }, type: "model.requested" }],
      [
        {
          data: {
            callId: "c_cancel",
            capability: { kind: "control", name: "eve__task_cancel" },
            input: { taskId },
            owner: { runId: "run_1" },
          },
          scope: { runId: "run_1", turnId },
          type: "call.requested",
        },
        {
          data: { outcome: "completed", runId: "run_1" },
          scope: { runId: "run_1", turnId },
          type: "model.settled",
        },
      ],
    );
    expect(waiting(view, turnId)).toEqual({ on: "session" });
  });

  it("waits on the session once a delivery the turn hasn't read joins it", () => {
    const view = viewOf(
      started,
      [callRequested, approval, modelSettled],
      [
        { data: { deliveryId: "d_2" }, type: "delivery.admitted" },
        {
          data: { deliveryId: "d_2", parts: [], turnId },
          scope: { turnId },
          type: "delivery.consumed",
        },
      ],
    );
    expect(waiting(view, turnId)).toEqual({ on: "session" });
  });

  it("is undefined for unknown and settled turns", () => {
    expect(waiting(viewOf(started), "missing")).toBeUndefined();
    const settled = viewOf(started, [
      modelSettled,
      {
        data: { turnId, outcome: "completed" },
        scope: { turnId },
        type: "turn.settled",
      },
    ]);
    expect(waiting(settled, turnId)).toBeUndefined();
  });
});

describe("announceWaiting", () => {
  const second: SessionEvent = {
    data: {
      interactionId: "i_2",
      request: { kind: "approval", prompt: "Also?" },
      subject: { callId: "c_1" },
    },
    scope: { turnId },
    type: "interaction.opened",
  };

  it("pauses the turn when a step leaves it waiting on an interaction", () => {
    const before = viewOf(started);
    const after = viewOf(started, [callRequested, approval, modelSettled]);
    expect(announceWaiting(before, after)).toEqual([
      {
        data: { awaiting: [{ interactionId: "i_1" }], turnId },
        type: "turn.paused",
      },
      { data: { deliveryId: "d_1", outcome: "awaiting-input", turnId }, type: "delivery.settled" },
    ]);
  });

  it("announces nothing while the session still works on the turn", () => {
    expect(announceWaiting(viewOf(started), viewOf(started, [callRequested, approval]))).toEqual(
      [],
    );
  });

  it("announces once, until someone new is asked", () => {
    const asked = [callRequested, approval, modelSettled];
    const paused = viewOf(started, asked, announceWaiting(viewOf(started), viewOf(started, asked)));
    expect(announceWaiting(paused, paused)).toEqual([]);
  });

  it("announces again when a delivery queues behind the person", () => {
    const asked = [callRequested, approval, modelSettled];
    const announced = announceWaiting(viewOf(started), viewOf(started, asked));
    const paused = viewOf(started, asked, announced);
    const queued = viewOf(started, asked, announced, [
      { data: { deliveryId: "d_3" }, type: "delivery.admitted" },
    ]);
    expect(announceWaiting(paused, queued).map((event) => event.type)).toEqual(["turn.paused"]);
  });

  it("answers for now one answer of a batch still waiting for the rest", () => {
    const asked = [callRequested, approval, second, modelSettled];
    const paused = viewOf(started, asked, announceWaiting(viewOf(started), viewOf(started, asked)));
    const consumed: SessionEvent[] = [
      { data: { deliveryId: "d_2" }, type: "delivery.admitted" },
      {
        data: { deliveryId: "d_2", parts: [{ kind: "text", text: "approve" }], turnId },
        scope: { turnId },
        type: "delivery.consumed",
      },
    ];
    const submitted: SessionEvent[] = [
      {
        data: {
          deliveryId: "d_2",
          interactionId: "i_1",
          responseId: "r_1",
          value: { optionId: "approve" },
        },
        type: "response.submitted",
      },
    ];
    const announced = announceWaiting(viewOf(started), viewOf(started, asked));
    const before = viewOf(started, asked, announced, consumed, submitted);
    expect(announceWaiting(paused, before)).toEqual([]);
    const answered = viewOf(started, asked, announced, consumed, submitted, [
      { data: { responseId: "r_1" }, type: "response.admitted" },
    ]);
    expect(waiting(answered, turnId)).toMatchObject({
      interactions: [{ interactionId: "i_2" }],
      on: "interaction",
    });
    // An admitted answer is not yet a settled interaction while the batch is weighed.
    expect(
      openInteractions(answered, { about: { callId: "c_1" } }).map((row) => row.interactionId),
    ).toEqual(["i_1", "i_2"]);
    expect(announceWaiting(before, answered)).toContainEqual({
      data: { deliveryId: "d_2", outcome: "awaiting-input", turnId },
      type: "delivery.settled",
    });
  });
});
