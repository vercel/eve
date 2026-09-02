export interface ScheduledRecoveryNotice {
  readonly attempt: number;
  readonly delayMs: number;
  readonly maxAttempts: number;
  readonly semanticError: {
    readonly hint?: string;
    readonly message: string;
    readonly name: string;
  };
}

/** Extracts only validated, safe presentation data from a scheduled failure. */
export function extractScheduledRecoveryNotice(event: {
  readonly details?: unknown;
}): ScheduledRecoveryNotice | null {
  if (!isRecord(event.details)) return null;
  const { details } = event;
  if (
    !nonEmptyString(details.semanticErrorId) ||
    !nonEmptyString(details.name) ||
    !nonEmptyString(details.message) ||
    !isRecord(details.recovery)
  ) {
    return null;
  }
  const recovery = details.recovery;
  if (
    recovery.kind !== "durable-retry" ||
    recovery.status !== "scheduled" ||
    !positiveSafeInteger(recovery.delayMs) ||
    !positiveSafeInteger(recovery.attempt) ||
    !positiveSafeInteger(recovery.maxAttempts) ||
    recovery.attempt > recovery.maxAttempts
  ) {
    return null;
  }
  const semanticError = {
    message: details.message.trim(),
    name: details.name.trim(),
    ...(nonEmptyString(details.hint) ? { hint: details.hint.trim() } : {}),
  };
  return {
    attempt: recovery.attempt,
    delayMs: recovery.delayMs,
    maxAttempts: recovery.maxAttempts,
    semanticError,
  };
}

export function formatScheduledRecoveryNotice(notice: ScheduledRecoveryNotice): string {
  const seconds = Math.max(1, Math.round(notice.delayMs / 1_000));
  return [
    notice.semanticError.name,
    "",
    notice.semanticError.message,
    "",
    `Retrying automatically in about ${seconds} seconds (attempt ${notice.attempt} of ${notice.maxAttempts}).`,
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
