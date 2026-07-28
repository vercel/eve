/**
 * Shape and behavior classification for pending input requests, shared by
 * the harness resolution path and protocol clients (e.g. the dev TUI's
 * rendering decisions).
 */
import type { InputRequest } from "#runtime/input/types.js";
import { isSessionLimitContinuationRequest } from "#harness/session-limit-continuation.js";

/** Shared approval predicate: a request whose options are exactly `approve` / `deny`. */
export function isApprovalRequest(request: InputRequest): boolean {
  return (
    request.options?.length === 2 &&
    request.options[0]?.id === "approve" &&
    request.options[1]?.id === "deny"
  );
}

/**
 * Behavioral class of a pending input request.
 *
 * `"required"` — the request must be explicitly answered before the turn can
 * move on. While one is unanswered, any other arriving input is queued and
 * replayed on the step after the answer. The pending batch never churns, so
 * the request ids the user is answering stay valid.
 *
 * `"dismissable"` — a plain follow-up message counts as the user moving on.
 * The request resolves as a real `tool-result` with `status: "ignored"` and
 * the model continues with the message in the same step.
 */
export type InputRequestClass = "dismissable" | "required";

/** Classifies one pending request; see {@link InputRequestClass}. */
export function classifyInputRequest(request: InputRequest): InputRequestClass {
  // A tool approval gates a model-emitted tool call. AI SDK requires the
  // approval response to resolve in isolation, and skipping it would leave
  // the intercepted call permanently un-adjudicated.
  if (isApprovalRequest(request)) {
    return "required";
  }
  // A session-limit continuation guards the next model call itself:
  // "ignore and continue" cannot continue -- the pre-model gate re-parks
  // while the violation holds -- and, being harness-authored, the request
  // has no history anchor on which an ignored outcome could be recorded.
  if (isSessionLimitContinuationRequest(request)) {
    return "required";
  }
  // Everything else wraps a model-emitted tool call whose ignored outcome
  // is expressible as a tool-result, so dismissal is always representable.
  // There is no third class.
  return "dismissable";
}
