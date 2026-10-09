import { contentPhase } from "#protocol/session-events/catalog.js";
import type { ErrorInfo } from "#protocol/session-events/envelope.js";
import type { ContentCompletedData } from "#protocol/session-events/families/content.js";

// What built-in channels post: a turn's reply text as each part completes, and failures with
// the error's code as their hint. Narration (text the turn continues after) isn't posted.

/** The text a completed content part replies with, or `undefined` for anything else. */
export function replyTextOf(part: ContentCompletedData): string | undefined {
  if (part.kind !== "text" || contentPhase(part.phase) !== "reply") return undefined;
  return typeof part.value === "string" && part.value.length > 0 ? part.value : undefined;
}

/** A failure as the error hint formatter reads it. */
export function errorHintOf(error: ErrorInfo | undefined): {
  readonly message?: string;
  readonly details?: { readonly name: string };
} {
  return error === undefined ? {} : { details: { name: error.code }, message: error.message };
}
