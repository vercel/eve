import { z } from "#compiled/zod/index.js";

import { conforming, envelopeOf, id, jsonValue, valueReference } from "../common.js";
import type { Envelope, JsonValue, ValueReference } from "../envelope.js";

/** A content part's kind. Open: `text`, `reasoning`, `result`, and `file` today. */
export type ContentKind = "text" | "reasoning" | "result" | "file" | (string & {});

/** Whether a part narrates work the turn continues with, or replies. Open; unknown reads as narration. */
export type ContentPhase = "narration" | "reply" | (string & {});

/** A preview of a part's value. The first record for a part announces it with its kind. */
export interface ContentDeltaData {
  readonly partId: string;
  /** On the announcing record only. */
  readonly kind?: ContentKind;
  readonly delta: string;
}

export interface ContentCompletedData {
  readonly partId: string;
  readonly runId: string;
  readonly kind: ContentKind;
  /** The part's whole value: text for text and reasoning, JSON for a result, a file's metadata. */
  readonly value?: JsonValue;
  readonly valueRef?: ValueReference;
  readonly phase: ContentPhase;
  /** A cancel stopped the part; its value is what streamed. */
  readonly interrupted?: true;
  /** For kinds a reader doesn't know. */
  readonly mediaType?: string;
  readonly fallbackText?: string;
}

export type ContentDelta = Envelope<"content.delta", ContentDeltaData>;
export type ContentCompleted = Envelope<"content.completed", ContentCompletedData>;
export type ContentFact = ContentCompleted;
export type ContentProgress = ContentDelta;

export const contentSchemas = {
  "content.completed": envelopeOf(
    "content.completed",
    conforming<ContentCompletedData>()(
      z.object({
        fallbackText: z.string().optional(),
        interrupted: z.literal(true).optional(),
        kind: z.string(),
        mediaType: z.string().optional(),
        partId: id,
        phase: z.string(),
        runId: id,
        value: jsonValue.optional(),
        valueRef: valueReference.optional(),
      }),
    ),
  ),
};

export const contentProgressSchemas = {
  "content.delta": envelopeOf(
    "content.delta",
    conforming<ContentDeltaData>()(
      z.object({ delta: z.string(), kind: z.string().optional(), partId: id }),
    ),
  ),
};
