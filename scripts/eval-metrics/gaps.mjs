// Outcome classification for one eval attempt. A gap is an attempt that says
// nothing about the model or eve: it counts toward coverage but is excluded
// from pass rates and from latency and cost medians.

/**
 * Gap reasons, in classification priority order:
 *
 * - `job-missing`: The publish job found no artifact for a planned leg.
 * - `eval-missing`: A planned eval has no result in its leg's artifacts.
 * - `provider-unavailable`: The model provider or network failed: HTTP 429/5xx, or a network-level error.
 * - `stream-write-failed`: eve could not write its durable event stream.
 * - `timeout-before-first-step`: The eval timed out before any model step completed.
 * - `error-before-first-step`: The eval errored before any model step completed.
 */
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
  // An eval that never completed a model step is a gap only when nothing in its
  // sessions failed for a real reason. Infrastructure failures returned above,
  // so any failure left (a first step rejected for its request, such as a
  // context too long, or a failed session) is the eval's own failure, even
  // though the eval then records an error.
  const realFailure = failures.length > 0;
  if (completedSteps === 0 && timedOut && !realFailure) return gap("timeout-before-first-step");
  if (completedSteps === 0 && error !== undefined && !realFailure)
    return gap("error-before-first-step");
  if (timedOut) return { outcome: "timed_out" };
  // The runner's own definition (eve's derive-run-facts), so the eval report
  // and the benchmark record agree on what parked means.
  if (evalArtifact?.result?.derived?.parked === true) return { outcome: "parked" };
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
