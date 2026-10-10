import {
  type OpenRequest,
  openRequests,
  type SessionProjection,
} from "#protocol/session-projection.js";
import { answeredInteractionIds } from "#protocol/session-projection/selectors.js";

/**
 * The request a typed reply answers: the first open request nobody has answered yet, in this
 * delivery or with an answer still admitted for its batch. A budget
 * prompt comes first, since the session settles it before anything else; the rest follow the
 * order of the session's `interaction.opened` events. Channels that can only show text show this
 * request alone, so a reply answers the request the person sees.
 */
export function firstOpenInput(
  projection: SessionProjection,
  answered: (requestId: string) => boolean = () => false,
): OpenRequest | undefined {
  const admitted =
    projection.view === undefined ? new Set<string>() : answeredInteractionIds(projection.view);
  const open = openRequests(projection.view).filter(
    (input) => !answered(input.request.requestId) && !admitted.has(input.request.requestId),
  );
  return open.find((input) => input.request.kind === "session-limit") ?? open[0];
}
