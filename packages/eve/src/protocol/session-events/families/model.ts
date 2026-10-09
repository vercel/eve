import { z } from "#compiled/zod/index.js";

import { MODEL_OUTCOMES } from "../catalog.js";
import { conforming, envelopeOf, errorInfo, id } from "../common.js";
import type { Envelope, ErrorInfo } from "../envelope.js";

/** What a model run belongs to: a turn, or a context change's summary. */
export type ModelOwner = { readonly turnId: string } | { readonly changeId: string };

export interface ModelRequestedData {
  readonly runId: string;
  readonly owner: ModelOwner;
}

export interface ModelStartedData {
  readonly runId: string;
  /** The model the run's participants chose. */
  readonly modelId: string;
}

export type ModelOutcome = "completed" | "failed" | "interrupted" | "abandoned";

export interface ModelSettledData {
  readonly runId: string;
  readonly outcome: ModelOutcome;
  /** The provider's finish reason, as an open string: `stop`, `tool-calls`, `length`, …. */
  readonly finishReason?: string;
  readonly generationId?: string;
  readonly error?: ErrorInfo;
}

export type ModelRequested = Envelope<"model.requested", ModelRequestedData>;
export type ModelStarted = Envelope<"model.started", ModelStartedData>;
export type ModelSettled = Envelope<"model.settled", ModelSettledData>;
export type ModelFact = ModelRequested | ModelStarted | ModelSettled;

const owner = conforming<ModelOwner>()(
  z.union([z.object({ turnId: id }), z.object({ changeId: id })]),
);

export const modelSchemas = {
  "model.requested": envelopeOf(
    "model.requested",
    conforming<ModelRequestedData>()(z.object({ owner, runId: id })),
  ),
  "model.settled": envelopeOf(
    "model.settled",
    conforming<ModelSettledData>()(
      z.object({
        error: errorInfo.optional(),
        finishReason: z.string().optional(),
        generationId: z.string().optional(),
        outcome: z.enum(MODEL_OUTCOMES),
        runId: id,
      }),
    ),
  ),
  "model.started": envelopeOf(
    "model.started",
    conforming<ModelStartedData>()(z.object({ modelId: z.string(), runId: id })),
  ),
};
