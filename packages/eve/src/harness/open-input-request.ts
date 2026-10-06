import { inReplyOrder } from "#channel/prompt-queue.js";
import {
  openInputs,
  type SessionInput,
  type SessionProjection,
} from "#protocol/session-projection.js";

/**
 * The request a typed reply answers: the first open request nobody has answered yet, in the
 * order {@link inReplyOrder} gives the session's `input.requested` events. Channels that can
 * only show text show requests one at a time in this order, so a reply answers the request the
 * person sees.
 */
export function firstOpenInput(
  projection: SessionProjection,
  answered: (requestId: string) => boolean = () => false,
): SessionInput | undefined {
  const open = openInputs(projection).filter((input) => !answered(input.request.requestId));
  return inReplyOrder(open, (input) => input.request)[0];
}
