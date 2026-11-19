import { z } from "#compiled/zod/index.js";

import { conforming, envelopeOf, id, usage } from "../common.js";
import type { Envelope, Usage } from "../envelope.js";

/** What spent the usage. Absent for usage nothing owns, such as cache warming. */
export type UsageOwner =
  | { readonly runId: string }
  | { readonly callId: string }
  | { readonly changeId: string };

/** The payload of `usage.recorded`: tokens and cost spent, and what spent them. */
export interface UsageRecordedData {
  readonly owner?: UsageOwner;
  /** Open: `model` today. */
  readonly kind: "model" | (string & {});
  readonly usage: Usage;
}

/** The fact recording usage, such as a model run's tokens. */
export type UsageRecorded = Envelope<"usage.recorded", UsageRecordedData>;
/** Any fact in the `usage` family. */
export type UsageFact = UsageRecorded;

export const usageSchemas = {
  "usage.recorded": envelopeOf(
    "usage.recorded",
    conforming<UsageRecordedData>()(
      z.object({
        kind: z.string(),
        owner: z
          .union([z.object({ runId: id }), z.object({ callId: id }), z.object({ changeId: id })])
          .optional(),
        usage,
      }),
    ),
  ),
};
