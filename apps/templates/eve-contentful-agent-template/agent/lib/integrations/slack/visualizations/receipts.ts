import { defineState } from "../../../state";

/**
 * Table and chart delivery outcomes for one turn. Suppress final prose only after successful
 * delivery with no failed visualization attempts. Explicit session-limit continuations
 * transfer ownership to the resumed turn without resetting outcomes.
 * Keep the original table state key and structure for saved-session compatibility.
 */
export const visualizationReceipts = defineState<{
  turnId: string;
  posted: boolean;
  failed: boolean;
} | null>("contentful.table-receipts", () => null);

/**
 * Accumulates a visualization's terminal posting outcome for the current turn.
 *
 * @param turnId - Turn that owns the table or chart delivery attempt.
 * @param posted - Whether Slack confirmed successful delivery, including a text fallback.
 * @remarks A failure remains recorded even if a later attempt succeeds, allowing explanatory prose.
 */
export const recordVisualizationDelivery = (
  turnId: string,
  posted: boolean
): void => {
  visualizationReceipts.update((previous) => {
    const current =
      previous?.turnId === turnId
        ? previous
        : { failed: false, posted: false, turnId };
    return {
      failed: current.failed || !posted,
      posted: current.posted || posted,
      turnId,
    };
  });
};
