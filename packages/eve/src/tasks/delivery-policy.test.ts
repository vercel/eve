import { describe, expect, it } from "vitest";

import { CONDITIONAL_DELIVERY_INSTRUCTION } from "#shared/empty-delivery.js";
import {
  TASK_DELIVERY_AUTO_INSTRUCTION,
  TASK_DELIVERY_INITIATING_INSTRUCTION,
  TASK_DELIVERY_SETTLED_INSTRUCTION,
  TASK_DELIVERY_SILENT_LAUNCH_INSTRUCTION,
} from "#tasks/delivery-context.js";
import { resolveDeliveryPolicy } from "#tasks/delivery-policy.js";

describe("resolveDeliveryPolicy", () => {
  it.each([
    ["scheduled launch", "initiating", true, true, CONDITIONAL_DELIVERY_INSTRUCTION, true],
    ["user launch", "initiating", true, false, TASK_DELIVERY_INITIATING_INSTRUCTION, false],
    ["settled wake", "settled", false, true, TASK_DELIVERY_SETTLED_INSTRUCTION, false],
  ] as const)(
    "resolves %s",
    (
      _name,
      taskDeliveryPhase,
      isFirstTurn,
      hasScheduleProvenance,
      instruction,
      allowsEmptyDelivery,
    ) => {
      expect(
        resolveDeliveryPolicy({
          taskDeliveryPolicy: "cohort",
          hasScheduleProvenance,
          hasOutputSchema: false,
          isChild: false,
          isFirstTurn,
          taskDeliveryPhase,
        }),
      ).toEqual({ allowsEmptyDelivery, instruction });
    },
  );

  it.each(["pending", "settled"] as const)(
    "allows auto to withhold a %s report",
    (taskDeliveryPhase) => {
      expect(
        resolveDeliveryPolicy({
          taskDeliveryPolicy: "auto",
          taskDeliveryPhase,
          hasScheduleProvenance: false,
          hasOutputSchema: false,
          isChild: false,
          isFirstTurn: false,
        }),
      ).toEqual({ allowsEmptyDelivery: true, instruction: TASK_DELIVERY_AUTO_INSTRUCTION });
    },
  );

  it.each(["auto-silent", "cohort-silent"] as const)(
    "silences only a launch under %s",
    (taskDeliveryPolicy) => {
      const input = {
        taskDeliveryPolicy,
        hasScheduleProvenance: false,
        hasOutputSchema: false,
        isChild: false,
        isFirstTurn: false,
      } as const;
      expect(resolveDeliveryPolicy({ ...input, taskDeliveryPhase: "initiating" })).toEqual({
        allowsEmptyDelivery: true,
        instruction: TASK_DELIVERY_SILENT_LAUNCH_INSTRUCTION,
      });
      expect(resolveDeliveryPolicy({ ...input, taskDeliveryPhase: "none" })).toEqual({
        allowsEmptyDelivery: false,
      });
      expect(resolveDeliveryPolicy({ ...input, taskDeliveryPhase: "settled" })).toEqual(
        taskDeliveryPolicy === "auto-silent"
          ? { allowsEmptyDelivery: true, instruction: TASK_DELIVERY_AUTO_INSTRUCTION }
          : { allowsEmptyDelivery: false, instruction: TASK_DELIVERY_SETTLED_INSTRUCTION },
      );
    },
  );

  it("allows an empty pending wake without instructing the model to stay silent", () => {
    expect(
      resolveDeliveryPolicy({
        taskDeliveryPolicy: "cohort",
        hasScheduleProvenance: false,
        hasOutputSchema: false,
        isChild: false,
        isFirstTurn: false,
        taskDeliveryPhase: "pending",
      }),
    ).toEqual({ allowsEmptyDelivery: true });
  });

  it.each([
    ["structured output", true, false],
    ["child session", false, true],
  ] as const)("keeps %s mandatory", (_name, hasOutputSchema, isChild) => {
    expect(
      resolveDeliveryPolicy({
        taskDeliveryPolicy: "cohort",
        hasScheduleProvenance: true,
        hasOutputSchema,
        isChild,
        isFirstTurn: true,
        taskDeliveryPhase: "initiating",
      }),
    ).toEqual({ allowsEmptyDelivery: false });
  });

  it("acknowledges background work launched on a later turn", () => {
    expect(
      resolveDeliveryPolicy({
        taskDeliveryPolicy: "cohort",
        hasOutputSchema: false,
        hasScheduleProvenance: true,
        isChild: false,
        isFirstTurn: false,
        taskDeliveryPhase: "initiating",
      }),
    ).toEqual({
      allowsEmptyDelivery: false,
      instruction: TASK_DELIVERY_INITIATING_INSTRUCTION,
    });
  });
});
