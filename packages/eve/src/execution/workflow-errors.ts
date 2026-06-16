/**
 * Serializes and rebuilds workflow errors across hook and step
 * boundaries.
 */

/**
 * Reduces an arbitrary throwable to a shape that survives the
 * serialization the workflow devkit performs on step inputs.
 */
export function normalizeSerializableError(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return error;
  }

  const ownProperties = Object.fromEntries(Object.entries(error)) as Record<string, unknown>;

  return {
    ...ownProperties,
    cause: error.cause === undefined ? undefined : normalizeSerializableError(error.cause),
    message: error.message,
    name: error.name,
    stack: error.stack,
  };
}

/**
 * Rebuilds an {@link Error} from the normalized hook payload sent by a
 * child workflow.
 */
export function rebuildSerializableError(error: unknown): Error {
  if (!isRecord(error)) {
    return new Error(String(error));
  }

  const message = typeof error.message === "string" ? error.message : String(error);
  const rebuilt = new Error(message);

  if (typeof error.name === "string") {
    rebuilt.name = error.name;
  }

  if (typeof error.stack === "string") {
    rebuilt.stack = error.stack;
  }

  if ("cause" in error) {
    (rebuilt as Error & { cause?: unknown }).cause = isRecord(error.cause)
      ? rebuildSerializableError(error.cause)
      : error.cause;
  }

  const mutable = rebuilt as Error & Record<string, unknown>;
  for (const [key, value] of Object.entries(error)) {
    if (key === "message" || key === "name" || key === "stack" || key === "cause") {
      continue;
    }
    mutable[key] = value;
  }

  return rebuilt;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
