import { describe, expect, it } from "vitest";

import { emptySessionView } from "#protocol/session-projection/fold.js";
import type { DeliveryRow, ResponseRow, SessionView } from "#protocol/session-projection/tables.js";

import { answerTurnedDown, hasRead, reachedTask } from "./task-projection.js";

const STARTED_AT = "2026-01-01T00:00:00.000Z";

function viewWith(input: {
  readonly deliveries?: readonly Partial<DeliveryRow>[];
  readonly responses?: readonly Partial<ResponseRow>[];
}): SessionView {
  const view = emptySessionView();
  const deliveries = view.deliveries as Record<string, DeliveryRow>;
  for (const [index, row] of (input.deliveries ?? []).entries()) {
    deliveries[row.deliveryId!] = {
      introducedAt: index,
      startedAt: STARTED_AT,
      status: "consumed",
      ...row,
    } as DeliveryRow;
  }
  const responses = view.responses as Record<string, ResponseRow>;
  for (const [index, row] of (input.responses ?? []).entries()) {
    responses[row.responseId!] = {
      interactionId: "ask-1",
      introducedAt: 100 + index,
      startedAt: STARTED_AT,
      status: "admitted",
      ...row,
    } as ResponseRow;
  }
  return view;
}

const task = { deliveryId: "first", sessionId: "wrun_1" };

describe("reachedTask", () => {
  it("keeps a follow-up in its task while it joins the task's turn, or hasn't been read", () => {
    const view = viewWith({
      deliveries: [
        { deliveryId: "first", turnId: "turn_0" },
        { deliveryId: "joined", turnId: "turn_0" },
        { deliveryId: "waiting", status: "admitted" },
      ],
    });
    expect(reachedTask(view, task, "first")).toBe(task);
    expect(reachedTask(view, task, "joined")).toBe(task);
    expect(reachedTask(view, task, "waiting")).toBe(task);
    expect(reachedTask(view, task, "unknown")).toBe(task);
  });

  it("names the follow-up's own task when it started a turn after the task's ended", () => {
    const view = viewWith({
      deliveries: [
        { deliveryId: "first", status: "settled", turnId: "turn_0" },
        { deliveryId: "late", turnId: "turn_1" },
      ],
    });
    expect(reachedTask(view, task, "late")).toEqual({ deliveryId: "late", sessionId: "wrun_1" });
  });
});

describe("answers", () => {
  it("reads an answer once admitted, and sees when the session turned it down", () => {
    const view = viewWith({
      responses: [
        { deliveryId: "answer", responseId: "r-1" },
        { deliveryId: "refused", outcome: "refused", responseId: "r-2", status: "settled" },
        { deliveryId: "applied", outcome: "applied", responseId: "r-3", status: "settled" },
      ],
    });
    expect(hasRead(view, "answer")).toBe(true);
    expect(hasRead(view, "never-sent")).toBe(false);
    expect(answerTurnedDown(view, "answer")).toBe(false);
    expect(answerTurnedDown(view, "refused")).toBe(true);
    expect(answerTurnedDown(view, "applied")).toBe(false);
  });
});
