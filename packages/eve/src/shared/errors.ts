import { isObject } from "#shared/guards.js";

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error === null || error === undefined) {
    return String(error);
  }
  if (isObject(error)) {
    if (typeof error.message === "string" && error.message.length > 0) {
      return error.message;
    }
    return safeJsonStringify(error);
  }
  return String(error);
}

export function toError(raw: unknown): Error {
  if (raw instanceof Error) {
    return raw;
  }

  const error = new Error(toErrorMessage(raw));
  if (!isObject(raw)) {
    return error;
  }

  if (typeof raw.name === "string" && raw.name.length > 0) {
    error.name = raw.name;
  }
  if (typeof raw.stack === "string" && raw.stack.length > 0) {
    error.stack = raw.stack;
  }
  if ("cause" in raw && raw.cause !== undefined && raw.cause !== raw) {
    (error as Error & { cause?: unknown }).cause = raw.cause;
  }
  return error;
}

export function* walkCauseChain(error: unknown): Generator<unknown> {
  const seen = new Set<unknown>();
  let current = error;
  while (isObject(current) && !seen.has(current)) {
    seen.add(current);
    yield current;
    current = current.cause;
  }
}

function safeJsonStringify(value: unknown): string {
  try {
    const stringified = JSON.stringify(value);
    return stringified ?? String(value);
  } catch {
    return String(value);
  }
}
