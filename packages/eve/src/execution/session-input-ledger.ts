import type { DeliverHookPayload } from "#channel/types.js";

/**
 * Idempotency and cancellation facts for task deliveries admitted by this
 * owner. In-memory on purpose: the workflow body rebuilds it deterministically
 * on replay, and a successor never inherits in-flight tasks because handoff
 * requires every indexed task to be terminal.
 */
export class SessionInputLedger {
  private readonly cancelledTaskIds = new Set<string>();
  private readonly seenTaskDeliveryIds = new Set<string>();

  admit(delivery: DeliverHookPayload): boolean {
    const deliveryId = taskDeliveryId(delivery);
    if (deliveryId === undefined) return true;
    if (this.seenTaskDeliveryIds.has(deliveryId) || this.isCancelledDelivery(deliveryId)) {
      return false;
    }
    this.seenTaskDeliveryIds.add(deliveryId);
    return true;
  }

  rememberTask(taskId: string): void {
    this.seenTaskDeliveryIds.add(taskId);
  }

  cancelTask(taskId: string): void {
    this.cancelledTaskIds.add(taskId);
  }

  isTaskCancelled(taskId: string): boolean {
    return this.cancelledTaskIds.has(taskId);
  }

  private isCancelledDelivery(deliveryId: string): boolean {
    for (const taskId of this.cancelledTaskIds) {
      if (deliveryId === taskId || deliveryId.startsWith(`${taskId}:`)) return true;
    }
    return false;
  }
}

function taskDeliveryId(delivery: DeliverHookPayload): string | undefined {
  return delivery.taskDeliveryId ?? delivery.caller?.taskId;
}
