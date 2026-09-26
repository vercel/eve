import {
  initialConversationState,
  reduceChildCall,
  reduceConversationLifecycle,
  type ConversationState,
} from "#client/conversation-state.js";
import { defaultMessageReducer } from "#client/message-reducer.js";
import type { EveAgentReducerEvent } from "#client/reducer.js";
import type { MessageStreamEvent } from "#protocol/message.js";

export type ScopedConversationEvent =
  | { readonly scope: "root"; readonly event: EveAgentReducerEvent }
  | { readonly scope: "child"; readonly callId: string; readonly event: MessageStreamEvent };

const messageReducer = defaultMessageReducer();

/** Pure reduction of accepted parent/child observations; followers own transport and replay. */
export function reduceConversation(
  state: ConversationState,
  observation: ScopedConversationEvent,
): ConversationState {
  if (observation.scope === "child") {
    const call = state.children[observation.callId];
    if (
      call === undefined ||
      call.parentStatus === "cancelled" ||
      call.observation.status === "ended"
    )
      return state;
    const previous =
      call.observation.status === "following"
        ? call.observation.conversation
        : initialConversationState();
    const conversation = reduceConversation(previous, { scope: "root", event: observation.event });
    return {
      ...state,
      children: {
        ...state.children,
        [observation.callId]: { ...call, observation: { status: "following", conversation } },
      },
    };
  }
  if (observation.event.type === "client.child.following") {
    const call = state.children[observation.event.data.callId];
    if (
      call === undefined ||
      call.parentStatus === "cancelled" ||
      (call.observation.status !== "not-followed" && call.observation.status !== "unavailable")
    )
      return state;
    return {
      ...state,
      children: {
        ...state.children,
        [call.callId]: {
          ...call,
          observation: {
            status: "following",
            conversation:
              call.observation.status === "unavailable"
                ? (call.observation.conversation ?? initialConversationState())
                : initialConversationState(),
          },
        },
      },
    };
  }
  if (observation.event.type === "client.child.settled") {
    const call = state.children[observation.event.data.callId];
    if (call === undefined || call.observation.status === "ended") return state;
    const conversation =
      call.observation.status === "following"
        ? call.observation.conversation
        : call.observation.status === "unavailable"
          ? call.observation.conversation
          : undefined;
    const childObservation =
      "outcome" in observation.event.data
        ? {
            status: "ended" as const,
            conversation: conversation ?? initialConversationState(),
            outcome: observation.event.data.outcome,
          }
        : {
            status: "unavailable" as const,
            reason: observation.event.data.reason,
            conversation,
          };
    return {
      ...state,
      children: { ...state.children, [call.callId]: { ...call, observation: childObservation } },
    };
  }
  if (observation.event.type === "client.child.observed") {
    return reduceConversation(state, {
      scope: "child",
      callId: observation.event.data.callId,
      event: observation.event.data.event,
    });
  }
  const projected = messageReducer.reduce(state, observation.event);
  const next = reduceConversationLifecycle({ ...state, ...projected }, observation.event);
  return "meta" in observation.event ? reduceChildCall(next, observation.event) : next;
}

export const conversationReducer = {
  initial: initialConversationState,
  reduce(state: ConversationState, event: EveAgentReducerEvent): ConversationState {
    return reduceConversation(state, { scope: "root", event });
  },
};
