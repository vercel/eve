import type { DynamicTurn } from "#dynamic/definition.js";
import type { UserPart } from "#protocol/session-events/envelope.js";
import type { SessionView, TurnRow } from "#protocol/session-projection/tables.js";

export function latestTurn(view: SessionView): DynamicTurn | null {
  const id = view.session.latestTurnId;
  const row = id === undefined ? undefined : view.turns[id];
  if (row === undefined) return null;
  return { id: row.turnId, input: turnInput(view, row), status: row.status };
}

export function turnInput(view: SessionView, row: TurnRow): readonly UserPart[] {
  const cause = "deliveryId" in row.cause ? row.cause.deliveryId : undefined;
  return Object.values(view.deliveries)
    .filter(
      (delivery) =>
        delivery.turnId === row.turnId &&
        delivery.parts !== undefined &&
        (delivery.deliveryId === cause || delivery.introducedAt < row.introducedAt),
    )
    .sort((a, b) => a.introducedAt - b.introducedAt)
    .flatMap((delivery) => delivery.parts ?? []);
}

export function turnInputText(turn: DynamicTurn): string {
  return turn.input.flatMap((part) => (part.kind === "text" ? [part.text] : [])).join("\n");
}
