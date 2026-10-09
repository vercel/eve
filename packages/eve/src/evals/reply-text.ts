import { contentPhase } from "#protocol/session-events/catalog.js";
import type { ContentCompletedData } from "#protocol/session-events/families/content.js";

// What a turn replies, as evals read it: the text of each reply part. Narration, the text a turn
// continues after, isn't the reply.

/** The text a completed content part replies with, or `undefined` for anything else. */
export function replyTextOf(part: ContentCompletedData): string | undefined {
  if (part.kind !== "text" || contentPhase(part.phase) !== "reply") return undefined;
  return typeof part.value === "string" && part.value.length > 0 ? part.value : undefined;
}
