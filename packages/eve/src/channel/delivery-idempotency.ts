/** Maximum number of distinct delivery keys remembered by one logical session. */
export const DELIVERY_IDEMPOTENCY_WINDOW = 1024;

export function validateDeliveryIdempotencyKey(key: string | undefined): void {
  if (key !== undefined && (typeof key !== "string" || key.length === 0 || key.length > 256)) {
    throw new Error("idempotencyKey must be a nonempty string of at most 256 characters.");
  }
}
