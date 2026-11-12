import { fact } from "#harness/facts.js";
import type { Commit } from "#harness/types.js";
import type { FactOf } from "#protocol/session-events/facts.js";
import type { JsonValue } from "#shared/json.js";
import { commitOf } from "./commit.js";

/** Parts of a run's content that completed together, as one commit. */
export function completeParts(parts: readonly FactOf<"content.completed">["data"][]): Commit {
  return commitOf(parts.map((part) => fact("content.completed", part)));
}

/**
 * A reply part the turn wrote itself, with no model run: a harness's settle. Its scope names the
 * turn, so readers that don't fold place it in the turn's reply.
 */
export function turnReplyPart(input: {
  readonly turnId: string;
  readonly partId: string;
  /** Text, or a structured turn's `result`. */
  readonly kind: "text" | "result";
  readonly value: JsonValue;
}): Commit {
  const part = fact("content.completed", {
    kind: input.kind,
    partId: input.partId,
    phase: "reply",
    value: input.value,
  });
  return commitOf([{ ...part, scope: { turnId: input.turnId } }]);
}
