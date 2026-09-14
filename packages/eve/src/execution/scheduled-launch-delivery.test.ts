import { describe, expect, it } from "vitest";

import {
  createMessageAppendedEvent,
  createMessageCompletedEvent,
  createResultCompletedEvent,
} from "#protocol/message.js";
import { scheduledLaunchDeliveryEvent } from "#execution/scheduled-launch-delivery.js";

describe("scheduledLaunchDeliveryEvent", () => {
  const completed = createMessageCompletedEvent({
    message: "answer",
    sequence: 0,
    stepIndex: 0,
    turnId: "turn_0",
  });

  it("hides an initiating scheduled reply but keeps its completion event", () => {
    const appended = createMessageAppendedEvent({
      messageDelta: "answer",
      sequence: 0,
      stepIndex: 0,
      turnId: "turn_0",
    });

    expect(
      scheduledLaunchDeliveryEvent(appended, {
        isFirstTurn: true,
        isScheduled: true,
        taskPhase: "initiating",
      }),
    ).toBeUndefined();
    expect(
      scheduledLaunchDeliveryEvent(completed, {
        isFirstTurn: true,
        isScheduled: true,
        taskPhase: "initiating",
      }),
    ).toEqual(expect.objectContaining({ data: expect.objectContaining({ message: null }) }));
  });

  it("keeps a direct scheduled answer", () => {
    expect(
      scheduledLaunchDeliveryEvent(completed, {
        isFirstTurn: true,
        isScheduled: true,
        taskPhase: "none",
      }),
    ).toBe(completed);
  });

  it("keeps an interactive acknowledgement in a schedule-created session", () => {
    expect(
      scheduledLaunchDeliveryEvent(completed, {
        isFirstTurn: false,
        isScheduled: true,
        taskPhase: "initiating",
      }),
    ).toBe(completed);
  });

  it("hides an initiating scheduled structured result", () => {
    const result = createResultCompletedEvent({
      result: { status: "pending" },
      sequence: 0,
      stepIndex: 0,
      turnId: "turn_0",
    });
    expect(
      scheduledLaunchDeliveryEvent(result, {
        isFirstTurn: true,
        isScheduled: true,
        taskPhase: "initiating",
      }),
    ).toBeUndefined();
  });
});
