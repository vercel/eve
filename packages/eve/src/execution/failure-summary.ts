import { summarizeKnownError } from "#harness/semantic-errors/index.js";
import { formatError } from "#internal/logging.js";
import type { JsonObject } from "#shared/json.js";

export function summarizeFailure(
  error: unknown,
  fallbackCode: string,
): { readonly code: string; readonly details: JsonObject; readonly message: string } {
  const formatted = formatError(error);
  const summary = summarizeKnownError(error);
  let details = formatted;
  if (summary !== null) {
    const curated = {
      ...formatted,
      message: summary.message,
      name: summary.name,
      semanticErrorId: summary.id,
    };
    details = summary.hint === undefined ? curated : { ...curated, hint: summary.hint };
  }
  return {
    code: typeof details.name === "string" ? details.name : fallbackCode,
    details,
    message: typeof details.message === "string" ? details.message : String(error),
  };
}
