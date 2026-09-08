import type { AlsContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";
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

interface DeliveryInstructionState {
  readonly current: string;
  readonly pending: boolean;
}

const DeliveryInstructionStateKey = new ContextKey<DeliveryInstructionState>(
  "eve.deliveryInstructionState",
);

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
  readonly isFirstTurn: boolean;
  readonly hasScheduleProvenance: boolean;
  readonly taskDeliveryPhase: "none" | "initiating" | "pending" | "settled" | undefined;
}): DeliveryPolicy {
  // These runs have an explicit output consumer, so silence would violate the call contract.
  if (input.hasOutputSchema || input.isChild) return POLICIES.normal;
  // Partial cohort results are withheld until the parent can report the cohort once.
  if (input.taskDeliveryPhase === "pending") return POLICIES.pending;
  // A complete cohort owes its caller the consolidated result and must not disappear silently.
  if (input.taskDeliveryPhase === "settled") return POLICIES.settled;
  // Nobody prompted a schedule-created first turn, so starting work needs no acknowledgement.
  if (input.isFirstTurn && input.hasScheduleProvenance) return POLICIES.conditional;
  // User-prompted background work acknowledges acceptance without waiting for results.
  if (input.taskDeliveryPhase === "initiating") return POLICIES.initiating;
  // Ordinary turns retain the agent's normal response contract.
  return POLICIES.normal;
}

export function prepareDeliveryInstruction(
  ctx: AlsContext,
  policy: DeliveryPolicy,
): string | undefined {
  const instruction = policy.instruction;
  if (instruction === undefined) {
    ctx.delete(DeliveryInstructionStateKey);
    return undefined;
  }

  const state = ctx.get(DeliveryInstructionStateKey);
  if (state?.current !== instruction) {
    ctx.set(DeliveryInstructionStateKey, { current: instruction, pending: true });
    return instruction;
  }
  return state.pending ? state.current : undefined;
}

export function markDeliveryInstructionPersisted(ctx: AlsContext, instruction: string): void {
  const state = ctx.get(DeliveryInstructionStateKey);
  if (state?.current === instruction && state.pending) {
    ctx.set(DeliveryInstructionStateKey, { current: instruction, pending: false });
  }
}

export function requeueDeliveryInstruction(ctx: AlsContext): void {
  const state = ctx.get(DeliveryInstructionStateKey);
  if (state !== undefined) {
    ctx.set(DeliveryInstructionStateKey, { ...state, pending: true });
  }
}
