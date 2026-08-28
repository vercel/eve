import type { EveEval, EveEvalResult } from "#evals/types.js";

/** Builds result metadata shared by external eval reporters. */
export function buildEvalResultMetadata(
  evaluation: EveEval | undefined,
  result: EveEvalResult,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    ...evaluation?.metadata,
    eveSessionId: result.result.sessionId,
    eveStatus: result.result.status,
    eveVerdict: result.verdict,
    eveSkipReason: result.skipReason,
    eveToolCalls: result.result.derived.toolCalls.map((call) => call.name),
    eveSubagentCalls: result.result.derived.subagentCalls.map((call) => call.name),
    eveParked: result.result.derived.parked,
  };

  if (result.result.traceContexts.length > 0) {
    metadata.eveTraceIds = [
      ...new Set(result.result.traceContexts.map((traceContext) => traceContext.traceId)),
    ];
    metadata.eveTraceContexts = result.result.traceContexts;
  }

  const failedAssertions = result.assertions
    .filter((assertion) => !assertion.passed)
    .map((assertion) => ({ ...assertion }));
  if (failedAssertions.length > 0) metadata.eveFailedAssertions = failedAssertions;

  if (result.result.derived.failureCode) {
    metadata.eveFailureCode = result.result.derived.failureCode;
  }

  return metadata;
}
