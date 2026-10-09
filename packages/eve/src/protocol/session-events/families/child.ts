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

export type ChildOpened = Envelope<"child.opened", ChildOpenedData>;
export type ChildFact = ChildOpened;

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
};
