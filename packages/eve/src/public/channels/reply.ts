import { contentPhase } from "#protocol/session-events/catalog.js";
import type { ErrorInfo } from "#protocol/session-events/envelope.js";
import type { ContentCompletedData } from "#protocol/session-events/families/content.js";
import { formatErrorHint } from "#internal/logging.js";

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

/**
 * What a channel posts when a turn or the session fails, or `undefined` when it didn't: the
 * error's hint and id, and what the person can do next: try again, or, after a session that
 * can't recover, start a new conversation (`restart` names it: "message", "comment").
 */
export function failureNotice(
  ending: { readonly outcome: string; readonly error?: ErrorInfo },
  scope: "turn" | { readonly restart: string },
): string | undefined {
  if (ending.outcome !== "failed") return undefined;
  const hint = formatErrorHint(errorHintOf(ending.error));
  const errorId = ending.error?.id;
  const [opening, next] =
    scope === "turn"
      ? [
          "I hit an error while handling your request",
          "Please try again, rephrase, or reach out if it keeps failing.",
        ]
      : [
          "This session could not recover from an error",
          `Start a new ${scope.restart} to continue.`,
        ];
  return [`${opening}${hint}.`, next, ...(errorId ? [`Error id: ${errorId}`] : [])].join("\n\n");
}
