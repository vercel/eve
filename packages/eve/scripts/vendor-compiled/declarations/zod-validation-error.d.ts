import type { ZodError } from "#compiled/zod/index.js";

export interface FromErrorOptions {
  prefix?: string | null | undefined;
}

export interface ValidationError extends Error {}

export declare function fromError(
  error: ZodError | Error | unknown,
  options?: FromErrorOptions,
): ValidationError;
