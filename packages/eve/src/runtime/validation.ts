import type { ZodError } from "#compiled/zod/index.js";
import { fromError } from "#compiled/zod-validation-error/index.js";

/**
 * Formats one zod validation error into a concise single-message string.
 */
export function formatValidationError(error: ZodError): string {
  return fromError(error, { prefix: undefined }).message;
}
