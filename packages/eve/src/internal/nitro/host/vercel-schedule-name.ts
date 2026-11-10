import { createHash } from "node:crypto";

/** Vercel allows schedule names of up to 256 characters. */
export const VERCEL_SCHEDULE_NAME_MAX_LENGTH = 256;

const SAFE_SEGMENT = /^[0-9A-Za-z_-]+$/;
const UNSAFE_CHARACTERS = /[^0-9A-Za-z_-]+/g;
const HASH_LENGTH = 8;

/**
 * Names an authored schedule's Nitro task, which Vercel Schedules also uses as
 * the schedule name: `eve.<schedule>`, or `eve.<agent>.<schedule>` when the
 * agent builds as one service of a multi-service project, because those agents
 * share a deployment and its schedule names. `/` in a schedule name becomes
 * `.`, so `billing/sweep` is `eve.billing.sweep`.
 *
 * A part with characters Vercel does not allow, including `.`, keeps them as
 * `.` and gets a hash of its original value, so `a/b` and `a.b` never share a
 * name. A name over Vercel's length limit is cut and gets a hash of the whole.
 */
export function createVercelScheduleName(input: {
  readonly agentName?: string;
  readonly scheduleId: string;
}): string {
  const name = [
    "eve",
    ...(input.agentName === undefined ? [] : [toNamePart(input.agentName)]),
    toNamePart(input.scheduleId),
  ].join(".");
  if (name.length <= VERCEL_SCHEDULE_NAME_MAX_LENGTH) return name;

  const suffix = `-${hash(name)}`;
  return `${name.slice(0, VERCEL_SCHEDULE_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
}

function toNamePart(value: string): string {
  const segments = value.split("/");
  if (segments.every((segment) => SAFE_SEGMENT.test(segment))) return segments.join(".");

  const readable = value.replace(UNSAFE_CHARACTERS, ".").replace(/^\.+|\.+$/g, "");
  return `${readable || "schedule"}-${hash(value)}`;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, HASH_LENGTH);
}
