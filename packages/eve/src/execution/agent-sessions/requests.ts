import type { SubagentInteractionHookPayload } from "#channel/types.js";
import type { WorkflowToolRunRef } from "#execution/tools/workflow/messages.js";
import type { WorkflowToolRunInbox } from "#execution/tools/workflow/owner.js";
import type { RemoteAgentBinding } from "#eve-channel/support.js";

export type AgentSessionRequest = SubagentInteractionHookPayload;

export async function forwardAgentSessionRequest(input: {
  readonly from: WorkflowToolRunRef;
  readonly owner: WorkflowToolRunInbox;
  readonly replyTo: string;
  readonly request: AgentSessionRequest;
  readonly remote?: RemoteAgentBinding & { readonly sessionId: string };
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

function remoteInteractionId(sessionKey: string, interactionId: string): string {
  return `${sessionKey}/${interactionId}`;
}
