/**
 * Error thrown when the agent info route returns an authorized response whose
 * body is not a recognized agent-info payload.
 *
 * Distinct from {@link ClientError}: the request succeeded and authorization
 * was satisfied, but the inspection payload is unusable — a body that is not
 * JSON, or JSON that does not match the current schema (typically a version
 * skew between the deployment and this client). The conversation transport does
 * not depend on `/eve/v1/info`, so callers that only need a working connection
 * can treat this as "connected, no inspection data". The carried {@link issues}
 * let diagnostics name the offending fields instead of an opaque string.
 */
export class AgentInfoResponseError extends Error {
  /** Schema issue summaries, e.g. `"agent.model.id: Required"`. Empty when the body was not JSON. */
  readonly issues: readonly string[];

  constructor(issues: readonly string[] = []) {
    const detail = issues.length === 0 ? "" : ` (${issues.join("; ")})`;
    super(`The server returned an unrecognized response from the eve agent info route.${detail}`);
    this.name = "AgentInfoResponseError";
    this.issues = issues;
  }
}
