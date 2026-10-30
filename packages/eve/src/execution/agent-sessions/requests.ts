import type { SubagentInteractionHookPayload } from "#channel/types.js";
import type { WorkflowToolRunRef } from "#execution/tools/workflow/messages.js";
import type { WorkflowToolRunInbox } from "#execution/tools/workflow/owner.js";
import type { RemoteAgentBinding } from "#eve-channel/support.js";

/** A child's interaction fact, which the session that owns the run mirrors up to the root. */
export type AgentSessionRequest = SubagentInteractionHookPayload;

/**
 * Sends a child's interaction fact to the session that owns the run, which proxies it up the
 * owner chain to the root. Answers route back down to the child by interaction id; a remote
 * child's answers go to its remote session.
 */
export async function forwardAgentSessionRequest(input: {
  readonly from: WorkflowToolRunRef;
  readonly owner: WorkflowToolRunInbox;
  readonly replyTo: string;
  readonly request: AgentSessionRequest;
  readonly remote?: RemoteAgentBinding & { readonly sessionId: string };
}): Promise<void> {
  const { from, remote, request } = input;
  const route =
    request.route === undefined
      ? undefined
      : {
          ...request.route,
          // Only the child's own inbox reaches it.
          ...(request.route.childSessionInbox?.sessionId !== request.childSessionId && {
            childSessionInbox: undefined,
          }),
          ...(remote !== undefined && { remote }),
        };
  await input.owner.send({
    from,
    kind: "request",
    replyTo: input.replyTo,
    request: { event: route === undefined ? request : { ...request, route }, kind: "relay" },
  });
}
