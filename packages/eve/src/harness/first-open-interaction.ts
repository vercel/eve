import type { SessionProjection } from "#protocol/session-projection.js";
import { openRequests } from "#protocol/session-reader.js";
import { answeredInteractionIds } from "#protocol/session-projection/selectors.js";
import type { InteractionRow } from "#protocol/session-projection/tables.js";

/**
 * The request a typed reply answers: the first open request nobody has answered yet, in this
 * delivery or with an answer still admitted for its batch. A budget
 * prompt comes first, since the session settles it before anything else; the rest follow the
 * order of the session's `interaction.opened` events. Channels that can only show text show this
 * request alone, so a reply answers the request the person sees.
 */
export function firstOpenInteraction(
  projection: SessionProjection,
  answered: (interactionId: string) => boolean = () => false,
): InteractionRow | undefined {
  const admitted =
    projection.view === undefined ? new Set<string>() : answeredInteractionIds(projection.view);
  const open = openRequests(projection.view).filter(
    (row) => !answered(row.interactionId) && !admitted.has(row.interactionId),
  );
  return open.find((row) => row.request.kind === "budget") ?? open[0];
}
