// Outcome classification for one eval attempt. A gap is an attempt that says
// nothing about the model or eve: it counts toward coverage but is excluded
// from pass rates and from latency and cost medians.

/** Every gap reason, in classification priority order. */
export const GAP_REASONS = Object.freeze([
  // The publish job found no artifact for a planned leg.
  "job-missing",
  // A planned eval has no result in its leg's artifacts.
  "eval-missing",
  // The model provider or network failed: HTTP 429/5xx, or a network-level error.
  "provider-unavailable",
  // eve could not write its durable event stream.
  "stream-write-failed",
  // The eval timed out before any model step completed.
  "timeout-before-first-step",
  // The eval errored before any model step completed.
  "error-before-first-step",
]);

/** @typedef {"completed" | "timed_out" | "skipped" | "parked" | "gap"} Outcome */

const FAILURE_EVENTS = new Set(["step.failed", "turn.failed", "session.failed"]);
const NETWORK_FAILURE =
  /\b(UND_ERR_(?:BODY|CONNECT|HEADERS)_TIMEOUT|UND_ERR_SOCKET|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND)\b/;
const TIMEOUT_ERROR = /aborted due to timeout|TimeoutError/i;

/**
 * @param {object} evalArtifact parsed eval detail JSON
 * @returns {{ outcome: Outcome, gap_reason?: string }}
 */
export function classifyOutcome(evalArtifact) {
  if (evalArtifact?.verdict === "skipped") return { outcome: "skipped" };

  const events = (evalArtifact?.result?.sessions ?? []).flatMap((session) => session.events ?? []);
  const failures = events.filter((event) => FAILURE_EVENTS.has(event.type));
  if (failures.some(isProviderFailure)) return gap("provider-unavailable");
  if (failures.some((event) => event.data?.code === "WORKFLOW_STREAM_WRITE_FAILED"))
    return gap("stream-write-failed");

  const completedSteps = events.filter((event) => event.type === "step.completed").length;
  const error = typeof evalArtifact?.error === "string" ? evalArtifact.error : undefined;
  const timedOut = error !== undefined && TIMEOUT_ERROR.test(error);
  if (completedSteps === 0 && timedOut) return gap("timeout-before-first-step");
  if (completedSteps === 0 && error !== undefined) return gap("error-before-first-step");
  if (timedOut) return { outcome: "timed_out" };
  if (isParkedOnInput(evalArtifact)) return { outcome: "parked" };
  return { outcome: "completed" };
}

function gap(reason) {
  return { outcome: "gap", gap_reason: reason };
}

/**
 * Provider-side and network failures are gaps. Other model-call 4xx responses
 * (context too long, invalid request) and schema failures are real failures.
 */
export function isProviderFailure(event) {
  const { code, details } = event.data ?? {};
  if (code !== "MODEL_CALL_FAILED") return false;
  for (const status of [details?.statusCode, details?.upstreamStatusCode]) {
    if (typeof status === "number" && (status === 429 || status >= 500)) return true;
  }
  if (details?.semanticErrorId === "network-request-failed") return true;
  return NETWORK_FAILURE.test(JSON.stringify(details ?? {}) + (event.data?.message ?? ""));
}

/** The primary session's last turn lifecycle event parks it on a person. */
function isParkedOnInput(evalArtifact) {
  const primaryId = evalArtifact?.result?.sessionId;
  const primary = (evalArtifact?.result?.sessions ?? []).filter(
    (session) => session.sessionId === primaryId,
  );
  const lifecycle = primary
    .flatMap((session) => session.events ?? [])
    .filter((event) => event.type.startsWith("turn."))
    .sort((a, b) => Date.parse(a.meta?.at ?? "") - Date.parse(b.meta?.at ?? ""));
  const last = lifecycle.at(-1);
  return last?.type === "turn.waiting" && last.data?.on === "input";
}
