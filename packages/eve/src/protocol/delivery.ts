import { z } from "#compiled/zod/index.js";

/** The data-only part of an accepted command, carried across an HTTP or workflow boundary. */
export interface DeliveryReceipt {
  readonly sessionId: string;
  readonly deliveryId: string;
}

export const DeliveryResponseSchema = z.object({
  ok: z.literal(true),
  sessionId: z.string().min(1),
  deliveryId: z.string().min(1),
});
