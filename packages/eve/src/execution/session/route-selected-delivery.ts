import { routeDeliverToChildren } from "#execution/route-child-delivery.js";
import type { TurnSelection } from "#execution/session/input-queue.js";
import type { SessionStateCursor } from "#execution/session/state-cursor.js";
import type { SessionStepRunner } from "#execution/session/steps.js";

type RoutedTurnSelection =
  | { readonly kind: "cancel-turn" }
  | { readonly kind: "consumed" }
  | TurnSelection;

export async function routeSelectedDelivery(
  selection: TurnSelection,
  cursor: SessionStateCursor,
  steps: SessionStepRunner,
): Promise<RoutedTurnSelection> {
  const routed = await cursor.advance((state) =>
    routeDeliverToChildren({ delivery: selection.delivery, ...state }, steps),
  );
  if (routed.kind === "cancel-turn") return { kind: "cancel-turn" };
  if (routed.remainder === undefined) return { kind: "consumed" };
  return { ...selection, delivery: routed.remainder };
}
