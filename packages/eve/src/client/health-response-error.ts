/** Error thrown when a successful health request returns an invalid payload. */
export class HealthResponseError extends Error {
  /** Schema issue summaries. Empty when the body was not JSON. */
  readonly issues: readonly string[];

  constructor(issues: readonly string[] = []) {
    const detail = issues.length === 0 ? "" : ` (${issues.join("; ")})`;
    super(`The server returned an unrecognized response from the eve health route.${detail}`);
    this.name = "HealthResponseError";
    this.issues = issues;
  }
}
