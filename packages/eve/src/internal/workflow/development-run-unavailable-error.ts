const NAME = "DevelopmentRunUnavailableError";

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
