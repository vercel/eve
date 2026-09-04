import type { DeliveryDisposition } from "#execution/turn/types.js";

/** Receipts acknowledge this owner’s inputs without copying the session’s entire delivery ledger. */
export function selectDeliveries(
  ledger: Readonly<Record<string, DeliveryDisposition>>,
  eventIds: readonly string[],
): Record<string, DeliveryDisposition> {
  const deliveries: Record<string, DeliveryDisposition> = {};
  for (const eventId of eventIds) {
    const disposition = ledger[eventId];
    if (disposition !== undefined) deliveries[eventId] = disposition;
  }
  return deliveries;
}
