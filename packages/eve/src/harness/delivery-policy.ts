import { CONDITIONAL_DELIVERY_INSTRUCTION } from "#shared/empty-delivery.js";

export interface DeliveryPolicy {
  readonly allowsEmptyDelivery: boolean;
  readonly instruction?: string;
}

const NORMAL: DeliveryPolicy = { allowsEmptyDelivery: false };
const CONDITIONAL: DeliveryPolicy = {
  allowsEmptyDelivery: true,
  instruction: CONDITIONAL_DELIVERY_INSTRUCTION,
};

/** Resolves one policy for both model prompting and empty-response recovery. */
export function resolveDeliveryPolicy(input: {
  readonly hasOutputSchema: boolean;
  readonly hasScheduleProvenance: boolean;
  readonly isChild: boolean;
}): DeliveryPolicy {
  // These runs have an explicit output consumer, so silence would violate the call contract.
  if (input.hasOutputSchema || input.isChild) return NORMAL;
  // Nobody prompted a schedule-created first turn, so starting work needs no acknowledgement.
  return input.hasScheduleProvenance ? CONDITIONAL : NORMAL;
}
