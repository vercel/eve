import type { ChildCall, ConversationState } from "#client/conversation-state.js";
import { isJsonObjectValue } from "#shared/json.js";
import { defaultMessageReducer } from "#client/message-reducer.js";
import type { EveAgentReducer, EveAgentReducerEvent } from "#client/reducer.js";
import type { MessageStreamEvent } from "#protocol/message.js";

export function initialConversationState(): ConversationState {
  return { messages: [], turns: {}, inputs: {}, children: {} };
}

function updateChild(
  state: ConversationState,
  callId: string,
  update: (call: ChildCall) => ChildCall,
): ConversationState {
  const call = state.children[callId];
  if (call === undefined) return state;
  const next = update(call);
  return next === call ? state : { ...state, children: { ...state.children, [callId]: next } };
}

function reduceChildCall(state: ConversationState, event: MessageStreamEvent): ConversationState {
  if (event.type === "subagent.called") {
    if (state.children[event.data.callId]) return state;
    const child: ChildCall = {
      callId: event.data.callId,
      name: event.data.name,
      childSessionId: event.data.childSessionId,
      originTurnId: event.data.turnId,
      background: false,
      parentStatus: "dispatched",
      observation: { status: "not-followed" },
    };
    return { ...state, children: { ...state.children, [child.callId]: child } };
  }
  if (event.type === "turn.cancelled") {
    let children = state.children;
    for (const child of Object.values(state.children)) {
      if (
        child.originTurnId !== event.data.turnId ||
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
  if (event.type !== "subagent.completed" && event.type !== "action.result") return state;
  const callId = event.type === "subagent.completed" ? event.data.callId : event.data.result.callId;
  const background =
    event.type === "subagent.completed"
      ? event.data.backgroundTask !== undefined
      : isWorkingReceipt(event);
  if (event.type === "action.result" && !background) return state;
  return updateChild(state, callId, (child) =>
    background
      ? { ...child, background: true, parentStatus: "working" }
      : { ...child, parentStatus: "reported-complete" },
  );
}

function isWorkingReceipt(event: Extract<MessageStreamEvent, { type: "action.result" }>): boolean {
  const output = event.data.result.output;
  return (
    event.data.status === "completed" &&
    isJsonObjectValue(output) &&
    output.status === "working" &&
    typeof output.taskId === "string" &&
    typeof output.agentId === "string"
  );
}

/** Applies lifecycle identity and closure to an already projected message state. */
function reduceConversationLifecycle(
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
    case "approval.candidate": {
      const current = state.inputs[event.data.requestId];
      if (current === undefined || current.status === "settled") return state;
      if (event.data.outcome === "pending") return state;
      return {
        ...state,
        inputs: {
          ...state.inputs,
          [event.data.requestId]: { ...current, status: "open", response: undefined },
        },
      };
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

const messageReducer = defaultMessageReducer();

/** Pure reduction of accepted parent/child observations; followers own transport and replay. */
export function reduceConversation(
  state: ConversationState,
  event: EveAgentReducerEvent,
): ConversationState {
  if (event.type === "client.child.following") {
    return updateChild(state, event.data.callId, (call) => {
      if (
        call.parentStatus === "cancelled" ||
        (call.observation.status !== "not-followed" && call.observation.status !== "unavailable")
      )
        return call;
      return {
        ...call,
        observation: {
          status: "following",
          conversation:
            call.observation.status === "unavailable"
              ? (call.observation.conversation ?? initialConversationState())
              : initialConversationState(),
        },
      };
    });
  }
  if (event.type === "client.child.unavailable") {
    return updateChild(state, event.data.callId, (call) => {
      if (call.observation.status === "ended") return call;
      const conversation =
        call.observation.status === "following" || call.observation.status === "unavailable"
          ? call.observation.conversation
          : undefined;
      return {
        ...call,
        observation: { status: "unavailable", reason: event.data.reason, conversation },
      };
    });
  }
  if (event.type === "client.child.observed") {
    return updateChild(state, event.data.callId, (call) => {
      if (call.parentStatus === "cancelled" || call.observation.status === "ended") return call;
      const childEvent = event.data.event;
      const previous =
        call.observation.status === "following"
          ? call.observation.conversation
          : initialConversationState();
      const conversation = reduceConversation(previous, childEvent);
      let observation: ChildCall["observation"] = { status: "following", conversation };
      if (
        childEvent.type === "session.waiting" ||
        childEvent.type === "session.completed" ||
        childEvent.type === "session.failed"
      ) {
        if (
          childEvent.type !== "session.waiting" ||
          !Object.values(conversation.inputs).some((input) => input.status === "open")
        ) {
          const lastTurn = Object.values(conversation.turns).at(-1);
          observation = {
            status: "ended",
            conversation,
            outcome:
              childEvent.type === "session.failed" || lastTurn?.status === "failed"
                ? "failed"
                : lastTurn?.status === "cancelled"
                  ? "cancelled"
                  : "completed",
          };
        }
      }
      return { ...call, observation };
    });
  }
  const projected = messageReducer.reduce(state, event);
  const next = reduceConversationLifecycle({ ...state, ...projected }, event);
  return "meta" in event ? reduceChildCall(next, event) : next;
}

export const conversationReducer: EveAgentReducer<ConversationState> = {
  initial: initialConversationState,
  reduce: reduceConversation,
};
