import type { DeliverHookPayload } from "#channel/types.js";

export interface DeliveryBuffers {
  readonly currentHookDeliveries: DeliverHookPayload[];
  readonly replacedHookDeliveries: DeliverHookPayload[];
  readonly turnDeliveries: DeliverHookPayload[];
}

export type HookDeliveryBuffer = "current-hook" | "replaced-hook";

export function createDeliveryBuffers(): DeliveryBuffers {
  return {
    currentHookDeliveries: [],
    replacedHookDeliveries: [],
    turnDeliveries: [],
  };
}

export function bufferHookDelivery(
  buffers: DeliveryBuffers,
  delivery: DeliverHookPayload,
  source: HookDeliveryBuffer,
): void {
  const target =
    source === "current-hook" ? buffers.currentHookDeliveries : buffers.replacedHookDeliveries;
  target.push(delivery);
}

export function prependTurnDeliveries(
  buffers: DeliveryBuffers,
  deliveries: readonly DeliverHookPayload[] | undefined,
): void {
  if (deliveries !== undefined) buffers.turnDeliveries.unshift(...deliveries);
}

export function takeBufferedDelivery(buffers: DeliveryBuffers): DeliverHookPayload | undefined {
  return (
    buffers.turnDeliveries.shift() ??
    buffers.currentHookDeliveries.shift() ??
    buffers.replacedHookDeliveries.shift()
  );
}

export function takePriorityDelivery(buffers: DeliveryBuffers): DeliverHookPayload | undefined {
  return buffers.turnDeliveries.shift() ?? buffers.currentHookDeliveries.shift();
}
