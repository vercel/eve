import type { ScheduleExpression } from "#public/schedules/subscription.js";

export function normalizeScheduleExpression(expression: ScheduleExpression): ScheduleExpression {
  if (expression.type === "cron") {
    const normalized: {
      type: "cron";
      cron: string;
      timezone?: string;
      jitter?: number;
    } = {
      type: "cron",
      cron: expression.cron.trim().replace(/\s+/gu, " "),
    };
    if (expression.timezone !== undefined) normalized.timezone = expression.timezone;
    if (expression.jitter !== undefined) normalized.jitter = expression.jitter;
    return normalized;
  }
  const normalized: { type: "single"; at: string; timezone?: string } = {
    type: "single",
    at: expression.at,
  };
  if (expression.timezone !== undefined) normalized.timezone = expression.timezone;
  return normalized;
}

export function normalizeScheduleLimit(limit: number | undefined): number {
  if (limit === undefined) return 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Schedule list limit must be an integer from 1 through 100.");
  }
  return limit;
}

export function decodeScheduleCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const value = Number(cursor);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid schedule cursor.");
  return value;
}
