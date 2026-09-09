import type { ErrorCode } from "#compute/protocol.js";

/** Typed compute failure with a stable cross-boundary code. */
export class ComputeError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "ComputeError";
    this.code = code;
  }
}
