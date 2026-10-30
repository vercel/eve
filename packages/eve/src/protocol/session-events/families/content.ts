import { z } from "#compiled/zod/index.js";

import { conforming, envelopeOf, id, jsonValue, valueReference } from "../common.js";
import type { Envelope, JsonValue, ValueReference } from "../envelope.js";

/** Wire parts use `kind`: `type` names the event. Authoring and UI parts use `type`. */
/** A content part's kind. Open: `text`, `reasoning`, `result`, and `file` today. */
export type ContentKind = "text" | "reasoning" | "result" | "file" | (string & {});

/** Whether a part narrates work the turn continues with, or replies. Open; unknown reads as narration. */
/**
 * What a part is to the turn. `narration`: text the turn goes on after. `reply`: the turn's reply.
 * `draft`: an answer the agent's harness reviews before the turn replies, which may never be its
 * reply. A reader that doesn't know a phase reads it as narration.
 */
export type ContentPhase = "narration" | "reply" | "draft" | (string & {});

/** A preview of a part's value. The first record for a part announces it with its kind. */
export interface ContentDeltaData {
  readonly partId: string;
  /** On the announcing record only. */
  readonly kind?: ContentKind;
  /**
   * On the announcing record only, when the agent's harness decides the turn's reply: the part may
   * become a draft the harness doesn't keep. Its phase, narration, reply, or draft, comes when it
   * completes, so a surface that posts replies waits for that instead of streaming the part.
   */
  readonly draft?: true;
  readonly delta: string;
}

export interface ContentCompletedData {
  readonly partId: string;
  /** The model run that wrote the part. Absent for a part eve wrote without one. */
  readonly runId?: string;
  /** For a part no run wrote, such as a reply a harness settled its turn with: its turn. */
  readonly turnId?: string;
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
        runId: id.optional(),
        turnId: id.optional(),
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
      z.object({
        delta: z.string(),
        draft: z.literal(true).optional(),
        kind: z.string().optional(),
        partId: id,
      }),
    ),
  ),
};
