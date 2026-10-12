import type { ReactionTurn } from "#dynamic/definition.js";
import type { UserPart } from "#protocol/session-events/envelope.js";
import type { SessionView, TurnRow } from "#protocol/session-projection/tables.js";

/** The session's latest turn, from its tables alone, so it reads the same in every step. */
export function latestTurn(view: SessionView): ReactionTurn | null {
  const id = view.session.latestTurnId;
  const row = id === undefined ? undefined : view.turns[id];
  if (row === undefined) return null;
  return { id: row.turnId, input: turnInput(view, row), status: row.status };
}

/**
 * The parts a turn opened with: its cause, and the deliveries admitted before it started, which it
 * consumed together. One admitted after it started steers it, and isn't its input.
 */
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

/** The text of a turn's input. */
export function turnInputText(turn: ReactionTurn): string {
  return turn.input.flatMap((part) => (part.kind === "text" ? [part.text] : [])).join("\n");
}
