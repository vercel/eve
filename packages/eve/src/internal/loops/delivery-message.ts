import type { DeliverInput } from "#channel/types.js";

type LoopRuntimeLabel = "Temporal" | "Workflow";

export function parseLoopDeliveryMessage(
  input: DeliverInput,
  runtimeLabel: LoopRuntimeLabel,
): string {
  const unsupportedEntry = Object.entries(input.payload).find(
    ([key, value]) => key !== "message" && value !== undefined,
  );
  if (unsupportedEntry !== undefined || typeof input.payload.message !== "string") {
    throw new Error(`${runtimeLabel} loop runtime only supports plain-text follow-up deliveries.`);
  }
  if (input.payload.message.trim().length === 0) {
    throw new Error(`${runtimeLabel} loop runtime requires a non-empty follow-up message.`);
  }
  return input.payload.message;
}
