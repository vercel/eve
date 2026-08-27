import type { DeliverHookPayload } from "#channel/types.js";

/** Marks a task cancelled and removes its queued model-facing deliveries. */
export function discardCancelledTaskDeliveries(input: {
  readonly bufferedDeliveries: DeliverHookPayload[];
  readonly cancelledTaskIds: Set<string>;
  readonly taskId: string;
}): void {
  input.cancelledTaskIds.add(input.taskId);
  const kept = input.bufferedDeliveries.filter(
    (delivery) => !isCancelledTaskDelivery(delivery, input.cancelledTaskIds),
  );
  input.bufferedDeliveries.splice(0, input.bufferedDeliveries.length, ...kept);
}

/** True for a cancelled task's model-facing delivery; client lifecycle events remain visible. */
export function isCancelledTaskDelivery(
  delivery: DeliverHookPayload,
  cancelledTaskIds: ReadonlySet<string>,
): boolean {
  const deliveryId = delivery.taskDeliveryId ?? delivery.caller?.taskId;
  if (deliveryId === undefined) return false;
  return isCancelledTaskDeliveryId(deliveryId, cancelledTaskIds);
}

export function isCancelledTaskDeliveryId(
  deliveryId: string,
  cancelledTaskIds: ReadonlySet<string>,
): boolean {
  return [...cancelledTaskIds].some(
    (taskId) =>
      (deliveryId === taskId || deliveryId.startsWith(`${taskId}:`)) &&
      !deliveryId.startsWith(`${taskId}:client:`),
  );
}
