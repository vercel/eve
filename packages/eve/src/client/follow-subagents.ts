import type { ConversationState } from "#client/conversation-state.js";
import type { EveAgentProjection } from "#client/eve-agent-projection.js";
import type { EveAgentReducerEvent } from "#client/reducer.js";
import type { ClientSession } from "#client/session.js";
import { ChildStreamFollower } from "#client/child-stream-follower.js";
import type { MessageStreamEvent } from "#protocol/message.js";

/** Binds optional child transport to the store's projection without a second child-state ledger. */
export function followSubagents<TData>(input: {
  session: ClientSession;
  projection: EveAgentProjection<TData>;
  events: readonly MessageStreamEvent[];
  publish: () => void;
  cursors: Map<string, number>;
}): ChildStreamFollower {
  const project = (event: EveAgentReducerEvent) => {
    input.projection.append(event);
    input.publish();
  };
  const follower = new ChildStreamFollower({
    cursors: input.cursors,
    session: () => input.session,
    getCall: (callId) => (input.projection.data as ConversationState).children?.[callId],
    onFollowing: (callId) => project({ type: "client.child.following", data: { callId } }),
    onSettled: (data) => project({ type: "client.child.settled", data }),
    onChildEvent: (callId, event) =>
      project({ type: "client.child.observed", data: { callId, event } }),
  });
  for (const event of input.events) follower.acceptParentEvent(event);
  return follower;
}
