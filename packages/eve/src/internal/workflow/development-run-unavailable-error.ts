const NAME = "DevelopmentRunUnavailableError";

/**
 * Raised by the `eve dev` World when a caller looks up a hook whose run
 * belongs to a generation this dev server will not execute. It crosses the
 * parent/worker boundary as a plain error, so identity is its name and its
 * enumerable fields rather than the class.
 */
export class DevelopmentRunUnavailableError extends Error {
  readonly availability: "dormant" | "ineligible";
  readonly runId: string;

  constructor(input: { readonly availability: "dormant" | "ineligible"; readonly runId: string }) {
    super(
      "Local Workflow run was not resumed. Start a new conversation, or restart eve dev with --resume to attempt recovery.",
    );
    this.name = NAME;
    this.availability = input.availability;
    this.runId = input.runId;
  }

  static is(value: unknown): value is DevelopmentRunUnavailableError {
    return (
      value instanceof Error &&
      value.name === NAME &&
      typeof (value as { runId?: unknown }).runId === "string"
    );
  }
}
