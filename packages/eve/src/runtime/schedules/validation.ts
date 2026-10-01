import type { ScheduleExpression, ScheduleTiming } from "#public/schedules/collection.js";

export const SCHEDULE_DELIVERY_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;

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

export const MAX_SCHEDULE_DELAY_MINUTES = 525_600;

export function resolveScheduleTiming(
  timing: ScheduleTiming,
  now = Date.now(),
): ScheduleExpression {
  if (timing.type !== "delay") return validateScheduleExpression(timing);
  if (
    !Number.isSafeInteger(timing.minutes) ||
    timing.minutes < 1 ||
    timing.minutes > MAX_SCHEDULE_DELAY_MINUTES
  ) {
    throw new Error(
      `Schedule delay must be a whole number from 1 through ${MAX_SCHEDULE_DELAY_MINUTES} minutes.`,
    );
  }
  if (Object.keys(timing).some((key) => key !== "type" && key !== "minutes")) {
    throw new Error(
      "Relative schedule delays accept only type and minutes; no timezone is needed.",
    );
  }
  const at = new Date(Math.ceil((now + timing.minutes * 60_000) / 60_000) * 60_000);
  return { type: "single", at: at.toISOString().slice(0, 16), timezone: "UTC" };
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

/**
 * Resolves the delivery names a create call selected. The result is never
 * empty: a schedule without a delivery cannot exist, and the message tells the
 * model how to recover instead of guessing.
 */
export function resolveScheduleDeliveryNames(
  requested: unknown,
  configured: Readonly<Record<string, { readonly description: string }>>,
): string[] {
  const available = Object.entries(configured)
    .map(([name, delivery]) => `${name} (${delivery.description})`)
    .join("; ");
  if (!Array.isArray(requested) || requested.length === 0) {
    throw new Error(
      `A schedule needs at least one delivery. Ask the user where results should go, then retry with one or more of: ${available}.`,
    );
  }
  const names: string[] = [];
  for (const name of requested) {
    if (typeof name !== "string" || !Object.hasOwn(configured, name)) {
      throw new Error(
        `Unknown delivery ${JSON.stringify(name)}. Choose from: ${available}. If none fits, ask the user.`,
      );
    }
    if (!names.includes(name)) names.push(name);
  }
  return names;
}
