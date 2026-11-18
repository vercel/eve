import { z } from "#compiled/zod/index.js";

import { conforming, envelopeOf, errorInfo, id, known } from "../common.js";
import type { Envelope, ErrorInfo } from "../envelope.js";

/** What a model run belongs to: a turn, or a context change's summary. */
export type ModelOwner = { readonly turnId: string } | { readonly changeId: string };

/** The payload of `model.requested`: a model run is introduced for its owner. */
export interface ModelRequestedData {
  readonly runId: string;
  readonly owner: ModelOwner;
}

/**
 * An attempt at the run's provider call begins. Repeats while the run is open, once per attempt.
 */
export interface ModelStartedData {
  readonly runId: string;
  /** The model the run's participants chose. */
  readonly modelId: string;
  /**
   * Which try at this model step this is: 0 for the first. A run that replaces one a retry gave
   * up (after it published output) continues the count, so a run's first attempt can be above 0.
   */
  readonly attempt: number;
}

/** An attempt failed, and the same run tries again. The run's status doesn't change. */
export interface ModelRetriedData {
  readonly runId: string;
  /** The attempt that failed. */
  readonly attempt: number;
  readonly error: ErrorInfo;
}

/** How a model run ended, as recorded on `model.settled`. */
export type ModelOutcome = "completed" | "failed" | "interrupted" | "abandoned";

/** The payload of `model.settled`: a model run ends, with its outcome and the provider's finish reason. */
export interface ModelSettledData {
  readonly runId: string;
  readonly outcome: ModelOutcome;
  /** The provider's finish reason, as an open string: `stop`, `tool-calls`, `length`, …. */
  readonly finishReason?: string;
  readonly generationId?: string;
  readonly error?: ErrorInfo;
}

/** The fact that introduces a model run. */
export type ModelRequested = Envelope<"model.requested", ModelRequestedData>;
/** The fact recording that an attempt at a model run's provider call began. */
export type ModelStarted = Envelope<"model.started", ModelStartedData>;
/** The fact recording that a model run's attempt failed and the run tries again. */
export type ModelRetried = Envelope<"model.retried", ModelRetriedData>;
/** The terminal fact of a model run. */
export type ModelSettled = Envelope<"model.settled", ModelSettledData>;
/** Any fact in the `model` family. */
export type ModelFact = ModelRequested | ModelStarted | ModelRetried | ModelSettled;

const attempt = z.number().int().nonnegative();

const owner = conforming<ModelOwner>()(
  z.union([z.object({ turnId: id }), z.object({ changeId: id })]),
);

export const modelSchemas = {
  "model.requested": envelopeOf(
    "model.requested",
    conforming<ModelRequestedData>()(z.object({ owner, runId: id })),
  ),
  "model.retried": envelopeOf(
    "model.retried",
    conforming<ModelRetriedData>()(z.object({ attempt, error: errorInfo, runId: id })),
  ),
  "model.settled": envelopeOf(
    "model.settled",
    conforming<ModelSettledData>()(
      z.object({
        error: errorInfo.optional(),
        finishReason: z.string().optional(),
        generationId: z.string().optional(),
        outcome: known<ModelOutcome>(),
        runId: id,
      }),
    ),
  ),
  "model.started": envelopeOf(
    "model.started",
    conforming<ModelStartedData>()(z.object({ attempt, modelId: z.string(), runId: id })),
  ),
};
