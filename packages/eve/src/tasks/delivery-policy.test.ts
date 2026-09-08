import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import { CONDITIONAL_DELIVERY_INSTRUCTION } from "#shared/empty-delivery.js";
import {
  TASK_DELIVERY_INITIATING_INSTRUCTION,
  TASK_DELIVERY_PENDING_INSTRUCTION,
  TASK_DELIVERY_SETTLED_INSTRUCTION,
} from "#tasks/delivery-context.js";
import {
  markDeliveryInstructionPersisted,
  prepareDeliveryInstruction,
  requeueDeliveryInstruction,
  resolveDeliveryPolicy,
} from "#tasks/delivery-policy.js";

describe("resolveDeliveryPolicy", () => {
  it.each([
    ["scheduled launch", "initiating", true, true, CONDITIONAL_DELIVERY_INSTRUCTION, true],
    ["user launch", "initiating", true, false, TASK_DELIVERY_INITIATING_INSTRUCTION, false],
    ["pending wake", "pending", false, true, TASK_DELIVERY_PENDING_INSTRUCTION, true],
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
      const policy = resolveDeliveryPolicy({
        hasScheduleProvenance,
        hasOutputSchema: false,
        isChild: false,
        isFirstTurn,
        taskDeliveryPhase,
      });
      expect(policy).toMatchObject({ allowsEmptyDelivery, instruction });
    },
  );

  it.each([
    ["structured output", true, false],
    ["child session", false, true],
  ] as const)("keeps %s mandatory", (_name, hasOutputSchema, isChild) => {
    expect(
      resolveDeliveryPolicy({
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

  it("queues an instruction once, then queues it again when the policy changes", () => {
    const ctx = new ContextContainer();
    const initiating = resolveDeliveryPolicy({
      hasOutputSchema: false,
      hasScheduleProvenance: false,
      isChild: false,
      isFirstTurn: true,
      taskDeliveryPhase: "initiating",
    });
    const pending = resolveDeliveryPolicy({
      hasOutputSchema: false,
      hasScheduleProvenance: false,
      isChild: false,
      isFirstTurn: false,
      taskDeliveryPhase: "pending",
    });

    expect(prepareDeliveryInstruction(ctx, initiating)).toBe(TASK_DELIVERY_INITIATING_INSTRUCTION);
    markDeliveryInstructionPersisted(ctx, TASK_DELIVERY_INITIATING_INSTRUCTION);
    expect(prepareDeliveryInstruction(ctx, initiating)).toBeUndefined();
    expect(prepareDeliveryInstruction(ctx, pending)).toBe(TASK_DELIVERY_PENDING_INSTRUCTION);
  });

  it("requeues the current instruction after history is replaced", () => {
    const ctx = new ContextContainer();
    const policy = resolveDeliveryPolicy({
      hasOutputSchema: false,
      hasScheduleProvenance: false,
      isChild: false,
      isFirstTurn: false,
      taskDeliveryPhase: "settled",
    });

    const instruction = prepareDeliveryInstruction(ctx, policy);
    expect(instruction).toBe(TASK_DELIVERY_SETTLED_INSTRUCTION);
    if (instruction === undefined) throw new TypeError("Expected a delivery instruction.");
    markDeliveryInstructionPersisted(ctx, instruction);
    requeueDeliveryInstruction(ctx);

    expect(prepareDeliveryInstruction(ctx, policy)).toBe(TASK_DELIVERY_SETTLED_INSTRUCTION);
  });
});
