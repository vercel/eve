import type {
  SubagentAuthorizationEventHookPayload,
  SubagentInputRequestHookPayload,
} from "#channel/types.js";
import type { WorkflowToolRunRef } from "#execution/tools/workflow/messages.js";
import type { WorkflowToolRunInbox } from "#execution/tools/workflow/owner.js";
import type { RemoteAgentBinding } from "#eve-channel/support.js";

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
  readonly owner: WorkflowToolRunInbox;
  readonly replyTo: string;
  readonly request: AgentSessionRequest;
  readonly remote?: RemoteAgentBinding & { readonly sessionId: string };
}): Promise<void> {
  const { from, request } = input;
  if (request.kind === "subagent-authorization-event") {
    await input.owner.send({
      from,
      kind: "request",
      replyTo: input.replyTo,
      request: { event: request, kind: "authorization-request" },
    });
    return;
  }
  await input.owner.send({
    from,
    inputSource: request.inputSource,
    remote: input.remote,
    kind: "request",
    replyTo: request.childContinuationToken,
    childSessionInbox:
      request.childSessionInbox?.sessionId === request.childSessionId
        ? request.childSessionInbox
        : undefined,
    request: { kind: "input-batch", requests: request.event.requests },
    requestCoordinates: {
      sequence: request.event.sequence,
      stepIndex: request.event.stepIndex,
      turnId: request.event.turnId,
    },
  });
}
