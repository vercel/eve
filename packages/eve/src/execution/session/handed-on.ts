import type { DeliverHookPayload, DeliverPayload } from "#channel/types.js";

/**
 * A delivery the session handed on to the children whose requests it answers, so a restore never
 * delivers that share again. Handed on whole, the session won't read it itself; handed on in part,
 * `rest` is the payload it still reads, what the delivery left for it (such as a channel's state).
 */
export interface HandedOn {
  readonly deliveryId: string;
  readonly rest?: DeliverPayload;
}

/**
 * What routing `delivery` to children handed on, given the `remainder` it left this session: each
 * delivery it carried that the remainder no longer holds, or holds less of.
 */
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
