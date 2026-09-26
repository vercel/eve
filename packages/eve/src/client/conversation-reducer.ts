import {
  initialConversationState,
  reduceChildCall,
  reduceConversationLifecycle,
  type ConversationState,
} from "#client/conversation-state.js";
import { defaultMessageReducer } from "#client/message-reducer.js";
import type { EveAgentReducerEvent } from "#client/reducer.js";
import type { MessageStreamEvent } from "#protocol/message.js";

export type ConversationObservation =
  | { readonly scope: "root"; readonly event: EveAgentReducerEvent }
  | { readonly scope: "child"; readonly callId: string; readonly event: MessageStreamEvent };

const messageReducer = defaultMessageReducer();

/** Pure reduction of accepted parent/child observations; followers own transport and replay. */
export function reduceConversation(
  state: ConversationState,
  observation: ConversationObservation,
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
      call.observation.status !== "not-followed"
    )
      return state;
    return {
      ...state,
      children: {
        ...state.children,
        [call.callId]: {
          ...call,
          observation: { status: "following", conversation: initialConversationState() },
        },
      },
    };
  }
  if (observation.event.type === "client.child.ended") {
    const call = state.children[observation.event.data.callId];
    if (call === undefined || call.observation.status === "ended") return state;
    const conversation =
      call.observation.status === "following"
        ? call.observation.conversation
        : initialConversationState();
    return {
      ...state,
      children: {
        ...state.children,
        [call.callId]: {
          ...call,
          observation: { status: "ended", conversation, outcome: observation.event.data.outcome },
        },
      },
    };
  }
  if (observation.event.type === "client.child.unavailable") {
    const call = state.children[observation.event.data.callId];
    if (call === undefined || call.observation.status === "ended") return state;
    return {
      ...state,
      children: {
        ...state.children,
        [call.callId]: {
          ...call,
          observation: {
            status: "unavailable",
            reason: observation.event.data.reason,
            ...(call.observation.status === "following"
              ? { conversation: call.observation.conversation }
              : {}),
          },
        },
      },
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
