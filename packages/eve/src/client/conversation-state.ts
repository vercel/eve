import type { EveMessageData } from "#client/message-reducer-types.js";
import type { EveAgentReducerEvent } from "#client/reducer.js";
import type { InputRequest, InputResponse } from "#shared/input.js";
import { subagentParentTransition } from "#client/subagent-lifecycle.js";
import type { MessageStreamEvent, SubagentCalledStreamEvent } from "#protocol/message.js";

export interface ConversationTurn {
  readonly turnId: string;
  readonly status: "active" | "completed" | "cancelled" | "failed";
}

export interface ConversationInput {
  readonly request: InputRequest;
  readonly turnId: string;
  readonly stepIndex: number;
  readonly status: "open" | "responded" | "settled";
  readonly response?: InputResponse;
  readonly outcome?: string;
}

export type ChildObservation =
  | { readonly status: "not-followed" }
  | { readonly status: "following"; readonly conversation: ConversationState }
  | {
      readonly status: "ended";
      readonly conversation: ConversationState;
      readonly outcome: "completed" | "failed" | "cancelled";
    }
  | {
      readonly status: "unavailable";
      readonly reason: "unsupported-stream" | "stream-error";
      /** Partial detail remains renderable when a stream fails after observation began. */
      readonly conversation?: ConversationState;
    };

export interface ChildCall {
  readonly callId: string;
  readonly name: string;
  readonly childSessionId: string;
  readonly originTurnId: string;
  readonly background: boolean;
  /** Parent completion may precede the last child event; it is not an authoritative child outcome. */
  readonly parentStatus: "dispatched" | "working" | "reported-complete" | "cancelled";
  readonly observation: ChildObservation;
}

/** Renderable conversation state. Root and child input IDs occupy separate scopes. */
export interface ConversationState extends EveMessageData {
  readonly activeTurnId?: string;
  readonly turns: Readonly<Record<string, ConversationTurn>>;
  readonly inputs: Readonly<Record<string, ConversationInput>>;
  readonly children: Readonly<Record<string, ChildCall>>;
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

export function initialConversationState(): ConversationState {
  return { messages: [], turns: {}, inputs: {}, children: {} };
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

/** Inputs awaiting an answer, including requests introduced in earlier turns. */
export function openConversationInputs(state: ConversationState): readonly ConversationInput[] {
  return Object.values(state.inputs).filter((input) => input.status === "open");
}
