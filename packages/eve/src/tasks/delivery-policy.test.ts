import { describe, expect, it } from "vitest";

import { CONDITIONAL_DELIVERY_INSTRUCTION } from "#shared/empty-delivery.js";
import {
  TASK_DELIVERY_INITIATING_INSTRUCTION,
  TASK_DELIVERY_PENDING_INSTRUCTION,
  TASK_DELIVERY_SETTLED_INSTRUCTION,
} from "#tasks/delivery-context.js";
import { resolveDeliveryPolicy } from "#tasks/delivery-policy.js";

describe("resolveDeliveryPolicy", () => {
  it.each([
    ["scheduled launch", "initiating", true, CONDITIONAL_DELIVERY_INSTRUCTION, true],
    ["user launch", "initiating", false, TASK_DELIVERY_INITIATING_INSTRUCTION, false],
    ["pending wake", "pending", true, TASK_DELIVERY_PENDING_INSTRUCTION, true],
    ["settled wake", "settled", true, TASK_DELIVERY_SETTLED_INSTRUCTION, false],
  ] as const)(
    "resolves %s",
    (_name, taskDeliveryPhase, isScheduledTurn, instruction, allowsEmptyDelivery) => {
      expect(
        resolveDeliveryPolicy({
          hasOutputSchema: false,
          isChild: false,
          isScheduledTurn,
          taskDeliveryPhase,
        }),
      ).toEqual({ allowsEmptyDelivery, instruction });
    },
  );

  it.each([
    ["structured output", true, false],
    ["child session", false, true],
  ] as const)("keeps %s mandatory", (_name, hasOutputSchema, isChild) => {
    expect(
      resolveDeliveryPolicy({
        hasOutputSchema,
        isChild,
        isScheduledTurn: true,
        taskDeliveryPhase: "initiating",
      }),
    ).toEqual({ allowsEmptyDelivery: false });
  });
});
