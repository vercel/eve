import { routeDeliverToChildren } from "#execution/route-child-delivery.js";
import type { TurnSelection } from "#execution/session/input-queue.js";
import type { SessionStateCursor } from "#execution/session/state-cursor.js";

type RoutedTurnSelection =
  | { readonly kind: "cancel-turn" }
  | { readonly kind: "consumed" }
  | TurnSelection;

/** Routes one selected delivery exactly once, independent of active/parked mode. */
export async function routeSelectedDelivery(
  selection: TurnSelection,
  cursor: SessionStateCursor,
): Promise<RoutedTurnSelection> {
  const routed = await routeDeliverToChildren({
    delivery: selection.delivery,
    sessionWritable: cursor.sessionWritable,
    serializedContext: cursor.serializedContext,
    sessionState: cursor.sessionState,
  });
  await cursor.apply(routed);
  if (routed.kind === "cancel-turn") return { kind: "cancel-turn" };
  if (routed.remainder === undefined) return { kind: "consumed" };
  return { ...selection, delivery: routed.remainder };
}
