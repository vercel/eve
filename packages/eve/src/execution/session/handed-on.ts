import type { DeliverHookPayload, DeliverPayload } from "#channel/types.js";

export interface HandedOn {
  readonly deliveryId: string;
  readonly rest?: DeliverPayload;
}

export function handedOnBy(
  delivery: DeliverHookPayload,
  remainder: DeliverHookPayload | undefined,
): HandedOn[] {
  if (remainder === delivery) return [];
  const rests = new Map(
    (remainder?.deliveryMetadata ?? []).map((entry) => [
      entry.deliveryId,
      remainder?.payloads[entry.payloadIndex],
    ]),
  );
  return (delivery.deliveryMetadata ?? []).flatMap(({ deliveryId, payloadIndex }) => {
    if (!rests.has(deliveryId)) return [{ deliveryId }];
    const rest = rests.get(deliveryId);
    if (rest === undefined || rest === delivery.payloads[payloadIndex]) return [];
    return [{ deliveryId, rest }];
  });
}
