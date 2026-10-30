/** Maximum number of distinct delivery keys remembered by one logical session. */
export const DELIVERY_IDEMPOTENCY_WINDOW = 1024;
export const MAX_DELIVERY_IDEMPOTENCY_KEY_LENGTH = 256;

export function validateDeliveryIdempotencyKey(key: unknown): asserts key is string | undefined {
  if (
    key !== undefined &&
    (typeof key !== "string" ||
      key.length === 0 ||
      key.length > MAX_DELIVERY_IDEMPOTENCY_KEY_LENGTH)
  ) {
    throw new Error(
      `idempotencyKey must be a nonempty string of at most ${MAX_DELIVERY_IDEMPOTENCY_KEY_LENGTH} characters.`,
    );
  }
}

/**
 * The delivery id a caller's idempotency key names, so a repeated request is the same delivery
 * with the same receipt. UUID-shaped, like the ids the framework mints; within one session, keys
 * name distinct deliveries.
 */
export async function deliveryIdForIdempotencyKey(key: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`eve:delivery:${key}`)),
  );
  // RFC 9562 version 8 (custom) and variant bits.
  digest[6] = (digest[6]! & 0x0f) | 0x80;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0"));
  const joined = hex.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20, 32)}`;
}
