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
