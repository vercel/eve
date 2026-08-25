import { toErrorMessage } from "#shared/errors.js";

export const SANDBOX_COMMAND_OUTCOME_UNKNOWN_MESSAGE =
  "The command’s output stream was interrupted after submission. Its completion state is unknown; the sandbox was reattached. Inspect state before retrying.";

/** A submitted command lost its result transport, so replay would be unsafe. */
export class SandboxCommandOutcomeUnknownError extends Error {
  constructor(cause: unknown) {
    super(SANDBOX_COMMAND_OUTCOME_UNKNOWN_MESSAGE, { cause });
    this.name = "SandboxCommandOutcomeUnknownError";
  }
}

/** A submitted command lost its result transport and sandbox recovery also failed. */
export class SandboxCommandRecoveryError extends Error {
  constructor(input: { readonly commandError: unknown; readonly recoveryError: unknown }) {
    super(
      `The command’s output stream was interrupted after submission, so its completion state is unknown. The sandbox could not be reattached: ${toErrorMessage(input.recoveryError)}`,
      {
        cause: new AggregateError([input.commandError, input.recoveryError]),
      },
    );
    this.name = "SandboxCommandRecoveryError";
  }
}
