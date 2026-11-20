import type { ZodError } from "#compiled/zod/index.js";
import { fromError } from "#compiled/zod-validation-error/index.js";

export function formatValidationError(error: ZodError): string {
  return fromError(error, { prefix: undefined }).message;
}
