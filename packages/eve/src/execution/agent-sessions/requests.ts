import type {
  SubagentAuthorizationEventHookPayload,
  SubagentInputRequestHookPayload,
} from "#channel/types.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import type { WorkflowToolRunRef } from "#execution/tools/workflow/messages.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";

/** A child's question or sign-in, which only a person at the root can answer. */
export type AgentSessionRequest =
  | SubagentAuthorizationEventHookPayload
  | SubagentInputRequestHookPayload;

/**
 * Sends a child's question or sign-in to the session that owns the run, which
 * proxies it up the owner chain to the root. Answers route back down to the
 * child by request id.
 */
export async function forwardAgentSessionRequest(input: {
  readonly from: WorkflowToolRunRef;
  /** The run's inbox, which relays body messages to its session. */
  readonly inbox: string;
  readonly replyTo: string;
  readonly request: AgentSessionRequest;
}): Promise<void> {
  const { from, request } = input;
  if (request.kind === "subagent-authorization-event") {
    await resumeHookStep(input.inbox, {
      from,
      kind: "request",
      replyTo: input.replyTo,
      request: { event: request, kind: "authorization-request" },
    });
    return;
  }
  await resumeHookStep(input.inbox, {
    from,
    kind: "request",
    replyTo: childAnswerToken(request),
    request: { kind: "input-batch", requests: request.event.requests },
    requestCoordinates: {
      sequence: request.event.sequence,
      stepIndex: request.event.stepIndex,
      turnId: request.event.turnId,
    },
  });
}

/**
 * Current session inboxes take answers on their physical token. A remote
 * child's create-once operation hook is already a narrowed reply capability.
 */
function childAnswerToken(request: SubagentInputRequestHookPayload): string {
  const inbox = request.childSessionInbox;
  if (inbox?.sessionId === request.childSessionId) {
    return sessionInboxHookToken(sessionCommandHookToken(inbox.sessionId));
  }
  return request.childContinuationToken;
}
