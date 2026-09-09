import { toErrorMessage } from "#shared/errors.js";

/** Distinguishes authored admission failures from failed runtime lifecycle work. */
export class BoundaryHookError extends Error {
  constructor(cause: unknown) {
    super(toErrorMessage(cause), { cause });
    this.name = "BoundaryHookError";
  }
}
