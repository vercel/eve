import type { ErrorInfo } from "#protocol/session-events/envelope.js";
import type { RuntimeActionResult } from "#shared/action-types.js";

// How a call's result reads on `call.settled`: an explicitly failed runtime result failed.
// Error-shaped JSON can also be an ordinary successful tool value; its fields aren't a status.

export function callOutcomeOf(result: RuntimeActionResult): {
  readonly outcome: "completed" | "failed";
  readonly error?: ErrorInfo;
} {
  if (result.isError === true) {
    return {
      error: readOutputError(result.output) ?? {
        code: "ACTION_RESULT_FAILED",
        message: formatOutput(result.output),
      },
      outcome: "failed",
    };
  }
  return { outcome: "completed" };
}

function readOutputError(output: unknown): ErrorInfo | undefined {
  const record = parseRecord(output);
  if (record === undefined) return undefined;
  const code = typeof record.code === "string" && record.code.length > 0 ? record.code : undefined;
  const message =
    typeof record.message === "string" && record.message.length > 0 ? record.message : undefined;
  return code === undefined || message === undefined ? undefined : { code, message };
}

function parseRecord(output: unknown): Record<string, unknown> | undefined {
  if (output !== null && typeof output === "object") return output as Record<string, unknown>;
  if (typeof output !== "string") return undefined;
  const trimmed = output.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function formatOutput(output: unknown): string {
  if (typeof output === "string") return output;
  const serialized = JSON.stringify(output);
  return typeof serialized === "string" && serialized.length > 0 ? serialized : "Action failed.";
}
