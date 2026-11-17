import { createHash } from "node:crypto";

export const VERCEL_SCHEDULE_NAME_MAX_LENGTH = 256;

const SAFE_SEGMENT = /^[0-9A-Za-z_-]+$/;
const UNSAFE_CHARACTERS = /[^0-9A-Za-z_-]+/g;
const HASH_LENGTH = 8;

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
