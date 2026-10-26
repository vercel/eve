import { routeDeliverToChildren } from "#execution/route-child-delivery.js";
import type {
  DeliveryAdmission,
  SessionInputQueue,
  TurnSelection,
} from "#execution/session/input-queue.js";
import type { SessionStateCursor } from "#execution/session/state-cursor.js";
import { continueSessionLimitPrompts } from "#execution/session/usage-continuation.js";

type RoutedTurnSelection = (
  | { readonly kind: "cancel-turn" }
  | { readonly kind: "consumed" }
  | TurnSelection
) & {
  /** The Continue queued for the session's own prompts the delivery's grant settled. */
  readonly approval?: DeliveryAdmission;
};

/**
 * Routes one selected delivery exactly once, independent of active/parked mode, and queues a
 * Continue for the session's own prompts the grant it minted settled.
 */
export async function routeSelectedDelivery(
  selection: TurnSelection,
  input: { readonly cursor: SessionStateCursor; readonly queue: SessionInputQueue },
): Promise<RoutedTurnSelection> {
  const routed = await input.cursor.advance((state) =>
    routeDeliverToChildren({ delivery: selection.delivery, ...state }),
  );
  if (routed.kind === "cancel-turn") return { kind: "cancel-turn" };
  const approval = continueSessionLimitPrompts(input.queue, routed.approved);
  if (routed.remainder === undefined) return { approval, kind: "consumed" };
  return { ...selection, approval, delivery: routed.remainder };
}
