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
  /** The handle the run opened the session with, which names the remote's requests here. */
  readonly sessionKey: string;
}): Promise<void> {
  const { from, remote } = input;
  const request =
    remote === undefined ? input.request : remoteRequest(input.request, input.sessionKey);
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
 * A remote child's request as this session can trust it. A remote session describes its requests
 * itself, so the ids, call, session, grant, principal, callback and card it names are its claims.
 * Each of its interaction ids is named here under the handle that opened it (`sessionKey`), so a
 * remote opens and settles only its own mirrors, and an answer goes back under the id the remote
 * gave (the mirror's `origin.interactionId`). A sign-in shares a card only through `grant` and
 * `waitsOn`, so without them a remote's sign-in keeps its own card, and its answer never settles
 * another sign-in here. A remote's genuine sign-in names its own deployment's callback, so it never
 * shared one anyway.
 */
function remoteRequest(request: AgentSessionRequest, sessionKey: string): AgentSessionRequest {
  return {
    ...request,
    events: request.events.map((event): AgentSessionRequest["events"][number] => {
      const interactionId = remoteInteractionId(sessionKey, event.data.interactionId);
      switch (event.type) {
        case "interaction.opened": {
          const origin = {
            sessionId: request.childSessionId,
            ...event.data.origin,
            interactionId: event.data.interactionId,
          };
          const signIn = event.data.request.signIn;
          if (signIn === undefined)
            return { ...event, data: { ...event.data, interactionId, origin } };
          const { grant: _grant, waitsOn: _waitsOn, ...claimed } = signIn;
          const asked = { ...event.data.request, signIn: claimed };
          return { ...event, data: { ...event.data, interactionId, origin, request: asked } };
        }
        case "interaction.settled":
          return { ...event, data: { ...event.data, interactionId } };
        case "response.admitted":
          return { ...event, data: { ...event.data, interactionId } };
        case "response.settled":
          return { ...event, data: { ...event.data, interactionId } };
      }
    }),
  };
}

/** The id this session mirrors a remote session's interaction under. */
function remoteInteractionId(sessionKey: string, interactionId: string): string {
  return `${sessionKey}/${interactionId}`;
}
