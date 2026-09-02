/** A successful health request returned an unusable payload. */
export class HealthResponseError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[] = []) {
    const detail = issues.length === 0 ? "" : ` (${issues.join("; ")})`;
    super(`The server returned an unrecognized eve health response.${detail}`);
    this.name = "HealthResponseError";
    this.issues = issues;
  }
}
