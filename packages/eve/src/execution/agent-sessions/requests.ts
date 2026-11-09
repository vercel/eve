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
  const { from, remote } = input;
  const request = remote === undefined ? input.request : remoteRequest(input.request);
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

/**
 * A remote child's request as this session can trust it. A remote session describes its sign-ins
 * itself, so their grant, principal, callback and the card they wait on are its claims, as is the
 * call it names. A sign-in shares a card only through `grant` and `waitsOn`, so without them a
 * remote's sign-in keeps its own card, and its answer never settles another sign-in here. A
 * remote's genuine sign-in names its own deployment's callback, so it never shared one anyway.
 */
function remoteRequest(request: AgentSessionRequest): AgentSessionRequest {
  return {
    ...request,
    events: request.events.map((event) => {
      const signIn = event.type === "interaction.opened" ? event.data.request.signIn : undefined;
      if (event.type !== "interaction.opened" || signIn === undefined) return event;
      const { grant: _grant, waitsOn: _waitsOn, ...claimed } = signIn;
      return {
        ...event,
        data: { ...event.data, request: { ...event.data.request, signIn: claimed } },
      };
    }),
  };
}
