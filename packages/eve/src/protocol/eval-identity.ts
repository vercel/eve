/** Stable correlation identity for one execution of an eval case inside one eval run. */
export interface EvalExecutionIdentity {
  readonly evalId: string;
  readonly runId: string;
}

/** Framework-owned request header carrying the generated eval case id. */
export const EVE_EVAL_ID_HEADER = "x-eve-eval-id";

/** Framework-owned request header carrying the eval run id. */
export const EVE_EVAL_RUN_ID_HEADER = "x-eve-eval-run-id";

/** Reads an eval identity only when both correlation headers are present. */
export function readEvalExecutionIdentity(headers: Headers): EvalExecutionIdentity | undefined {
  const evalId = headers.get(EVE_EVAL_ID_HEADER)?.trim();
  const runId = headers.get(EVE_EVAL_RUN_ID_HEADER)?.trim();
  if (!evalId || !runId) return undefined;
  return { evalId, runId };
}

/** Returns request headers with framework-owned eval identity values applied. */
export function withEvalExecutionIdentity(
  headers: Readonly<Record<string, string>> | undefined,
  identity: EvalExecutionIdentity,
): Readonly<Record<string, string>> {
  const result = { ...headers };
  deleteHeader(result, EVE_EVAL_ID_HEADER);
  deleteHeader(result, EVE_EVAL_RUN_ID_HEADER);
  result[EVE_EVAL_ID_HEADER] = identity.evalId;
  result[EVE_EVAL_RUN_ID_HEADER] = identity.runId;
  return result;
}

function deleteHeader(headers: Record<string, string>, name: string): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name) delete headers[key];
  }
}
