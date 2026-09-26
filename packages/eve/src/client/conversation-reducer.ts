import type { ChildCall, ConversationState } from "#client/conversation-state.js";
import { subagentParentTransition } from "#client/subagent-lifecycle.js";
import { defaultMessageReducer } from "#client/message-reducer.js";
import type { EveAgentReducerEvent } from "#client/reducer.js";
import type { MessageStreamEvent, SubagentCalledStreamEvent } from "#protocol/message.js";

export function initialConversationState(): ConversationState {
  return { messages: [], turns: {}, inputs: {}, children: {} };
}

export function childCall(called: SubagentCalledStreamEvent): ChildCall {
  return {
    callId: called.data.callId,
    name: called.data.name,
    childSessionId: called.data.childSessionId,
    originTurnId: called.data.turnId,
    background: false,
    parentStatus: "dispatched",
    observation: { status: "not-followed" },
  };
}

export function reduceChildCall(
  state: ConversationState,
  event: MessageStreamEvent,
): ConversationState {
  const transition = subagentParentTransition(event);
  if (transition === undefined) return state;
  if (transition.type === "called") {
    const existing = state.children[transition.callId];
    if (existing !== undefined) return state;
    return {
      ...state,
      children: {
        ...state.children,
        [transition.callId]: childCall(event as SubagentCalledStreamEvent),
      },
    };
  }
  if (transition.type === "turn-cancelled") {
    let children = state.children;
    for (const child of Object.values(state.children)) {
      if (
        child.originTurnId !== transition.turnId ||
        child.background ||
        child.observation.status === "ended"
      )
        continue;
      children = {
        ...children,
        [child.callId]: {
          ...child,
          parentStatus: "cancelled",
          observation:
            child.observation.status === "following"
              ? {
                  status: "ended",
                  conversation: child.observation.conversation,
                  outcome: "cancelled",
                }
              : child.observation,
        },
      };
    }
    return children === state.children ? state : { ...state, children };
  }
  const child = state.children[transition.callId];
  if (child === undefined) return state;
  const next =
    transition.type === "background"
      ? { ...child, background: true, parentStatus: "working" as const }
      : { ...child, parentStatus: "reported-complete" as const };
  return { ...state, children: { ...state.children, [child.callId]: next } };
}

/** Applies lifecycle identity and closure to an already projected message state. */
export function reduceConversationLifecycle(
  state: ConversationState,
  event: EveAgentReducerEvent,
): ConversationState {
  switch (event.type) {
    case "turn.started":
      return {
        ...state,
        activeTurnId: event.data.turnId,
        turns: {
          ...state.turns,
          [event.data.turnId]: { turnId: event.data.turnId, status: "active" },
        },
      };
    case "turn.completed":
    case "turn.cancelled":
    case "turn.failed": {
      const { turnId } = event.data;
      return {
        ...state,
        activeTurnId: state.activeTurnId === turnId ? undefined : state.activeTurnId,
        turns: {
          ...state.turns,
          [turnId]: {
            turnId,
            status:
              event.type === "turn.completed"
                ? "completed"
                : event.type === "turn.failed"
                  ? "failed"
                  : "cancelled",
          },
        },
      };
    }
    case "input.requested": {
      const inputs = { ...state.inputs };
      for (const request of event.data.requests) {
        if (inputs[request.requestId] !== undefined) continue;
        inputs[request.requestId] = {
          request,
          turnId: event.data.turnId,
          stepIndex: event.data.stepIndex,
          status: "open",
        };
      }
      return { ...state, inputs };
    }
    case "client.input.responded": {
      const inputs = { ...state.inputs };
      for (const response of event.data.responses) {
        const current = inputs[response.requestId];
        if (current?.status !== "open") continue;
        inputs[response.requestId] = { ...current, response, status: "responded" };
      }
      return { ...state, inputs };
    }
    case "approval.settled": {
      const current = state.inputs[event.data.requestId];
      if (current === undefined || current.status === "settled") return state;
      return {
        ...state,
        inputs: {
          ...state.inputs,
          [event.data.requestId]: { ...current, status: "settled", outcome: event.data.outcome },
        },
      };
    }
    case "input.resolved": {
      const inputs = { ...state.inputs };
      for (const resolution of event.data.resolutions) {
        const current = inputs[resolution.requestId];
        if (current === undefined || current.status === "settled") continue;
        inputs[resolution.requestId] = {
          ...current,
          status: "settled",
          outcome: resolution.outcome,
          response: resolution.response ?? current.response,
        };
      }
      return { ...state, inputs };
    }
    default:
      return state;
  }
}

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
