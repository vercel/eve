import { CONDITIONAL_DELIVERY_INSTRUCTION } from "#shared/empty-delivery.js";
import {
  TASK_DELIVERY_INITIATING_INSTRUCTION,
  TASK_DELIVERY_PENDING_INSTRUCTION,
  TASK_DELIVERY_SETTLED_INSTRUCTION,
} from "#tasks/delivery-context.js";

export interface DeliveryPolicy {
  readonly allowsEmptyDelivery: boolean;
  readonly instruction?: string;
}

const POLICIES = {
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
    instruction: TASK_DELIVERY_PENDING_INSTRUCTION,
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
  readonly isScheduledTurn: boolean;
  readonly taskDeliveryPhase: "none" | "initiating" | "pending" | "settled" | undefined;
}): DeliveryPolicy {
  if (input.hasOutputSchema || input.isChild) return POLICIES.normal;
  if (input.taskDeliveryPhase === "pending") return POLICIES.pending;
  if (input.taskDeliveryPhase === "settled") return POLICIES.settled;
  if (input.isScheduledTurn) return POLICIES.conditional;
  if (input.taskDeliveryPhase === "initiating") return POLICIES.initiating;
  return POLICIES.normal;
}
