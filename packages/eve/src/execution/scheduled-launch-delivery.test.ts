import { describe, expect, it } from "vitest";

import { createMessageAppendedEvent, createMessageCompletedEvent } from "#protocol/message.js";
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
      scheduledLaunchDeliveryEvent(appended, { isScheduled: true, taskPhase: "initiating" }),
    ).toBeUndefined();
    expect(
      scheduledLaunchDeliveryEvent(completed, { isScheduled: true, taskPhase: "initiating" }),
    ).toEqual(expect.objectContaining({ data: expect.objectContaining({ message: null }) }));
  });

  it("keeps a direct scheduled answer", () => {
    expect(scheduledLaunchDeliveryEvent(completed, { isScheduled: true, taskPhase: "none" })).toBe(
      completed,
    );
  });
});
