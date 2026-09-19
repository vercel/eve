import type { TaskDeliveryPolicy } from "#channel/types.js";
import { CONDITIONAL_DELIVERY_INSTRUCTION } from "#shared/empty-delivery.js";
import {
  TASK_DELIVERY_AUTO_INSTRUCTION,
  TASK_DELIVERY_INITIATING_INSTRUCTION,
  TASK_DELIVERY_SETTLED_INSTRUCTION,
} from "#tasks/delivery-context.js";

export interface DeliveryPolicy {
  readonly allowsEmptyDelivery: boolean;
  readonly instruction?: string;
}

const POLICIES = {
  auto: { allowsEmptyDelivery: true, instruction: TASK_DELIVERY_AUTO_INSTRUCTION },
  conditional: {
    allowsEmptyDelivery: true,
    instruction: CONDITIONAL_DELIVERY_INSTRUCTION,
  },
  initiating: {
    allowsEmptyDelivery: false,
    instruction: TASK_DELIVERY_INITIATING_INSTRUCTION,
  },
  normal: { allowsEmptyDelivery: false },
  pending: {
    allowsEmptyDelivery: true,
  },
  settled: {
    allowsEmptyDelivery: false,
    instruction: TASK_DELIVERY_SETTLED_INSTRUCTION,
  },
} as const satisfies Record<string, DeliveryPolicy>;

/** Resolves one policy for both model prompting and empty-response recovery. */
export function resolveDeliveryPolicy(input: {
  readonly hasOutputSchema: boolean;
  readonly isChild: boolean;
  readonly isFirstTurn: boolean;
  readonly hasScheduleProvenance: boolean;
  readonly taskDeliveryPolicy: TaskDeliveryPolicy | undefined;
  readonly taskDeliveryPhase: "none" | "initiating" | "pending" | "settled" | undefined;
}): DeliveryPolicy {
  // These runs have an explicit output consumer, so silence would violate the call contract.
  if (input.hasOutputSchema || input.isChild) return POLICIES.normal;
  if (
    input.taskDeliveryPolicy === "auto" &&
    (input.taskDeliveryPhase === "pending" || input.taskDeliveryPhase === "settled")
  )
    return POLICIES.auto;
  if (input.taskDeliveryPhase === "pending") return POLICIES.pending;
  // Delivered terminal results must not disappear silently.
  if (input.taskDeliveryPhase === "settled") return POLICIES.settled;
  // Nobody prompted a schedule-created first turn, so starting work needs no acknowledgement.
  if (input.isFirstTurn && input.hasScheduleProvenance) return POLICIES.conditional;
  // User-prompted background work acknowledges acceptance without waiting for results.
  if (input.taskDeliveryPhase === "initiating") return POLICIES.initiating;
  // Ordinary turns retain the agent's normal response contract.
  return POLICIES.normal;
}
