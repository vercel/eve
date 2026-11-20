import { contentPhase } from "#protocol/session-events/catalog.js";
import type { ErrorInfo } from "#protocol/session-events/envelope.js";
import type { ContentCompletedData } from "#protocol/session-events/families/content.js";
import { formatErrorHint } from "#internal/logging.js";

export function replyTextOf(part: ContentCompletedData): string | undefined {
  if (part.kind !== "text" || contentPhase(part.phase) !== "reply") return undefined;
  return typeof part.value === "string" && part.value.length > 0 ? part.value : undefined;
}

export function errorHintOf(error: ErrorInfo | undefined): {
  readonly message?: string;
  readonly details?: { readonly name: string };
} {
  return error === undefined ? {} : { details: { name: error.code }, message: error.message };
}

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
