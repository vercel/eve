/**
 * Shared pure error projections used by public helpers and internals.
 */

import { isObject } from "#shared/guards.js";

/**
 * Projects an unknown throwable into a human-readable string.
 *
 * Plain objects are rendered as JSON rather than `"[object Object]"`.
 */
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

/**
 * Coerces an unknown throwable into a proper {@link Error} instance.
 *
 * Returns real Errors unchanged. For plain-object shapes (common after
 * structured-clone strips prototypes), copies useful `message`, `name`,
 * `stack`, and `cause` fields onto a fresh Error.
 */
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

function safeJsonStringify(value: unknown): string {
  try {
    const stringified = JSON.stringify(value);
    // `JSON.stringify` returns `undefined` for values whose top-level
    // reduces to `undefined` (functions, symbols, undefined itself).
    // Fall back so callers never receive a literal `"undefined"` that
    // they cannot tell apart from the real primitive.
    return stringified ?? String(value);
  } catch {
    return String(value);
  }
}
