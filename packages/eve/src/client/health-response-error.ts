import { EveError } from "#shared/eve-error.js";

/** A successful health request returned an unusable payload. */
export class HealthResponseError extends EveError {
  static override readonly errorName = "HealthResponseError";
  declare readonly code: "invalid_health_response";
  readonly issues: readonly string[];

  constructor(issues: readonly string[] = []) {
    const detail = issues.length === 0 ? "" : ` (${issues.join("; ")})`;
    super(
      "invalid_health_response",
      `The server returned an unrecognized eve health response.${detail}`,
    );
    this.issues = issues;
  }
}
