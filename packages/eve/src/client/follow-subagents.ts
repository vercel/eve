import type { ConversationState } from "#client/conversation-state.js";
import type { EveAgentProjection } from "#client/eve-agent-projection.js";
import type { EveAgentReducerEvent } from "#client/reducer.js";
import type { ClientSession } from "#client/session.js";
import { SubagentPump } from "#client/subagent-pump.js";
import type { MessageStreamEvent } from "#protocol/message.js";

/** Binds optional child transport to the store's projection without a second child-state ledger. */
export function followSubagents<TData>(input: {
  session: ClientSession;
  projection: EveAgentProjection<TData>;
  events: readonly MessageStreamEvent[];
  publish: () => void;
}): SubagentPump {
  const project = (event: EveAgentReducerEvent) => {
    input.projection.append(event);
    input.publish();
  };
  const pump = new SubagentPump({
    session: () => input.session,
    getCall: (callId) => (input.projection.data as ConversationState).children?.[callId],
    onFollowing: (callId) => project({ type: "client.child.following", data: { callId } }),
    onEnded: (callId, outcome) =>
      project({ type: "client.child.ended", data: { callId, outcome } }),
    onUnavailable: (callId, reason) =>
      project({ type: "client.child.unavailable", data: { callId, reason } }),
    onChildEvent: (callId, event) =>
      project({ type: "client.child.observed", data: { callId, event } }),
  });
  for (const event of input.events) pump.acceptParentEvent(event);
  return pump;
}
