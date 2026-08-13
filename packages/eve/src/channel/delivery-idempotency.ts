import type { ChannelDeliveryIdempotency } from "#channel/types.js";

/** Latest durably accepted replay identity for a session. */
export const CHANNEL_DELIVERY_RECEIPT_ATTRIBUTE = "$eve.channel_delivery_receipt";

export function serializeChannelDeliveryIdempotency(identity: ChannelDeliveryIdempotency): string {
  return JSON.stringify([identity.key, identity.fingerprint]);
}

export function parseChannelDeliveryIdempotency(
  value: unknown,
): ChannelDeliveryIdempotency | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== "string" ||
      parsed[0].length === 0 ||
      typeof parsed[1] !== "string" ||
      parsed[1].length === 0
    ) {
      return undefined;
    }
    return { fingerprint: parsed[1], key: parsed[0] };
  } catch {
    return undefined;
  }
}
