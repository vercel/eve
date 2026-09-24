/**
 * The time limit for each call of an agent or workflow tool, in
 * milliseconds. A call still working when it expires fails with
 * `TIMED_OUT`. `false` removes the limit; the owning session's lifetime
 * still bounds every call.
 */
export type TaskTimeout = number | false;

/** Validates an authored `timeout`; `owner` names the definition in the error. */
export function normalizeTaskTimeout(value: unknown, owner: string): TaskTimeout | undefined {
  if (value === undefined || value === false) return value;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  throw new Error(
    `${owner} "timeout" must be a positive number of milliseconds or false, received ${describe(value)}.`,
  );
}

function describe(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
