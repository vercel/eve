import { describe, expect, it } from "vitest";

import type { SessionEvent } from "#protocol/session-event.js";
import { emptySessionView, foldLine } from "#protocol/session-projection/fold.js";
import { waiting } from "#protocol/session-projection/selectors.js";
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
  it("is undefined while the model runs, and a person once only one can go on", () => {
    expect(waiting(viewOf(started, [callRequested, approval]), turnId)).toBeUndefined();
    expect(waiting(viewOf(started, [callRequested, approval, modelSettled]), turnId)).toMatchObject(
      { interactions: [{ interactionId: "i_1" }], on: "person" },
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

  it("is undefined once a delivery the turn hasn't read joins it", () => {
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
    expect(waiting(view, turnId)).toBeUndefined();
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

  it("pauses the turn when a step leaves it waiting on a person", () => {
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
    const answered = viewOf(
      started,
      asked,
      announceWaiting(viewOf(started), viewOf(started, asked)),
      [
        { data: { deliveryId: "d_2" }, type: "delivery.admitted" },
        {
          data: {
            deliveryId: "d_2",
            interactionId: "i_1",
            responseId: "r_1",
            value: { optionId: "approve" },
          },
          type: "response.submitted",
        },
        { data: { responseId: "r_1" }, type: "response.admitted" },
      ],
    );
    expect(announceWaiting(paused, answered)).toContainEqual({
      data: { deliveryId: "d_2", outcome: "awaiting-input", turnId },
      type: "delivery.settled",
    });
  });
});
