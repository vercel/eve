import { fact } from "#harness/facts.js";
import type { Commit } from "#harness/types.js";
import type { FactOf } from "#protocol/session-events/facts.js";
import { commitOf } from "./commit.js";

/** Parts of a run's content that completed together, as one commit. */
export function completeParts(parts: readonly FactOf<"content.completed">["data"][]): Commit {
  return commitOf(parts.map((part) => fact("content.completed", part)));
}
