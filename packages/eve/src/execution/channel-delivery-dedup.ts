import type { DeliverHookPayload } from "#channel/types.js";

/** Channel operations and task deliveries occupy distinct identities in the driver's replay ledger. */
export function acceptChannelOperation(
  delivery: Pick<DeliverHookPayload, "deliveryMetadata">,
  seen: Set<string>,
): boolean {
  const keys = (delivery.deliveryMetadata ?? [])
    .filter((entry) => entry.deliveryId.startsWith("operation:"))
    .map((entry) => `channel:${entry.deliveryId}`);
  if (keys.some((key) => seen.has(key))) return false;
  for (const key of keys) seen.add(key);
  return true;
}
