import type { ControlOrigin } from "#execution/session/input-queue.js";
import { principalOf } from "#execution/session/delivery-facts.js";
import type { ControlDelivery } from "#harness/types.js";

/** A control's delivery as its facts name it: the id, and its sender as the wire names them. */
export function controlDeliveryOf(origin: ControlOrigin): ControlDelivery {
  const principal = principalOf(origin.auth);
  return principal === undefined
    ? { deliveryId: origin.deliveryId }
    : { deliveryId: origin.deliveryId, principal };
}
