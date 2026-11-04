import { z } from "#compiled/zod/index.js";

import { conforming, envelopeOf, id } from "../common.js";
import type { Envelope } from "../envelope.js";

export interface ChildOpenedData {
  /** The child session; its own lifecycle lives in its own stream. */
  readonly sessionId: string;
  readonly owner: { readonly callId: string } | { readonly taskId: string };
  readonly name: string;
  /** The route that serves the child's stream: its own, or the parent-origin proxy for a remote child. */
  readonly stream: string;
}

/**
 * A delivery a child session accepted for one of this session's calls. The child's own stream
 * records the delivery's lifecycle as its `deliveryId`.
 */
export interface ChildSentData {
  /** The child session that accepted the delivery. */
  readonly sessionId: string;
  /** The delivery's id in the child's stream, not one of this session's deliveries. */
  readonly childDeliveryId: string;
  /** The call the delivery was sent for. */
  readonly callId: string;
}

export type ChildOpened = Envelope<"child.opened", ChildOpenedData>;
export type ChildSent = Envelope<"child.sent", ChildSentData>;
export type ChildFact = ChildOpened | ChildSent;

export const childSchemas = {
  "child.opened": envelopeOf(
    "child.opened",
    conforming<ChildOpenedData>()(
      z.object({
        name: z.string(),
        owner: z.union([z.object({ callId: id }), z.object({ taskId: id })]),
        sessionId: id,
        stream: z.string(),
      }),
    ),
  ),
  "child.sent": envelopeOf(
    "child.sent",
    conforming<ChildSentData>()(z.object({ callId: id, childDeliveryId: id, sessionId: id })),
  ),
};
