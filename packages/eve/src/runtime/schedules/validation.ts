import type { ScheduleExpression } from "#public/schedules/collection.js";

const SCHEDULE_IDENTIFIER = /^[0-9A-Za-z][0-9A-Za-z._-]{0,255}$/u;
const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::00)?$/u;

export function validateScheduleName(name: string): string {
  const normalized = name.trim();
  if (!SCHEDULE_IDENTIFIER.test(normalized)) {
    throw new Error(
      "Schedule name must be 1–256 characters, start with an ASCII letter or digit, and contain only letters, digits, '.', '_', and '-'.",
    );
  }
  return normalized;
}

export function validateScheduleExpression(expression: ScheduleExpression): ScheduleExpression {
  if (expression.type === "cron") {
    const cron = expression.cron.trim().replace(/\s+/gu, " ");
    if (cron.split(" ").length !== 5) {
      throw new Error("Schedule cron expressions must contain exactly five fields.");
    }
    const normalized: {
      type: "cron";
      cron: string;
      timezone?: string;
      jitter?: number;
    } = { type: "cron", cron };
    if (expression.timezone !== undefined) {
      normalized.timezone = validateTimezone(expression.timezone);
    }
    if (expression.jitter !== undefined) {
      if (
        !Number.isSafeInteger(expression.jitter) ||
        expression.jitter < 1 ||
        expression.jitter > 15
      ) {
        throw new Error("Schedule jitter must be an integer from 1 through 15 minutes.");
      }
      normalized.jitter = expression.jitter;
    }
    return normalized;
  }

  if (!LOCAL_DATE_TIME.test(expression.at)) {
    throw new Error(
      'One-time schedules require a minute-precision local datetime in "YYYY-MM-DDTHH:mm" or "YYYY-MM-DDTHH:mm:00" format without an offset or fractional seconds.',
    );
  }
  const normalized: { type: "single"; at: string; timezone?: string } = {
    type: "single",
    at: expression.at,
  };
  if (expression.timezone !== undefined)
    normalized.timezone = validateTimezone(expression.timezone);
  return normalized;
}

export function validateScheduleListLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Schedule list limit must be an integer from 1 through 100.");
  }
  return limit;
}

function validateTimezone(timezone: string): string {
  const normalized = timezone.trim();
  if (normalized.length === 0 || normalized.length > 50) {
    throw new Error("Schedule timezone must be a valid IANA timezone.");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(0);
  } catch {
    throw new Error(`Invalid IANA timezone: ${normalized}`);
  }
  return normalized;
}
